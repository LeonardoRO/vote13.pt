// 3D urna eletrônica (three.js).
// The vote logic lives in index.html (window.urna); this file only renders it:
// it listens to `urna:change`, paints the LCD onto a canvas texture and turns
// clicks/taps on the 3D keys into urna.pressDigit / confirma / corrige / branco.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const root  = document.documentElement;
const stage = document.getElementById('stage');
const live  = document.getElementById('live');
const urna  = window.urna;

// ---------------------------------------------------------------- helpers
const clamp01   = v => Math.min(1, Math.max(0, v));
const easeOut   = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
const easeBack  = t => { const c = 1.9; return 1 + (c+1)*Math.pow(t-1, 3) + c*Math.pow(t-1, 2); };
const lerp      = (a, b, k) => a + (b - a) * k;
const deg       = d => d * Math.PI / 180;

const F = {
  oswald: 'Oswald, "Arial Narrow", sans-serif',
  sans:   '"IBM Plex Sans", system-ui, sans-serif',
  mono:   '"IBM Plex Mono", ui-monospace, monospace',
  emoji:  '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif',
};

async function loadFonts(){
  const specs = ['500 40px Oswald','600 40px Oswald','700 40px Oswald',
    '400 40px "IBM Plex Sans"','500 40px "IBM Plex Sans"','600 40px "IBM Plex Sans"','700 40px "IBM Plex Sans"',
    '600 40px "IBM Plex Mono"','700 40px "IBM Plex Mono"'];
  await Promise.race([
    Promise.all(specs.map(s => document.fonts.load(s, 'AÇº13').catch(() => {}))),
    new Promise(r => setTimeout(r, 2500)),
  ]);
}

// Candidate photo, pre-rendered black & white like the real urna screen.
// Returns null if the image is missing or the canvas would be tainted (file://).
function loadPhoto(src, w, h){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try{
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d');
        const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        x.drawImage(img, (w - img.naturalWidth*s) / 2, 0, img.naturalWidth*s, img.naturalHeight*s);
        const d = x.getImageData(0, 0, w, h), p = d.data;
        for(let i = 0; i < p.length; i += 4){
          const g = (.299*p[i] + .587*p[i+1] + .114*p[i+2] - 128) * 1.08 + 131;
          p[i] = p[i+1] = p[i+2] = g;
        }
        x.putImageData(d, 0, 0);
        resolve(c);
      }catch(e){ resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function canvasTexture(canvas){
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Draw text with manual letter spacing (ctx.letterSpacing isn't everywhere yet).
function spaced(ctx, text, x, y, sp, align = 'left'){
  const chars = [...text];
  const ws = chars.map(c => ctx.measureText(c).width);
  const total = ws.reduce((a, b) => a + b, 0) + sp * (chars.length - 1);
  let cx = align === 'center' ? x - total/2 : align === 'right' ? x - total : x;
  const prev = ctx.textAlign; ctx.textAlign = 'left';
  chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += ws[i] + sp; });
  ctx.textAlign = prev;
  return total;
}

// "Usuário <b>burro</b>…" -> [{t, b}] segments (strings are our own constants).
const tpl = document.createElement('template');
function parseRich(html){
  tpl.innerHTML = html;
  const out = [];
  (function walk(n, b){
    for(const c of n.childNodes){
      if(c.nodeType === 3) out.push({t: c.nodeValue, b});
      else walk(c, b || c.nodeName === 'B');
    }
  })(tpl.content, false);
  return out;
}
const plain = html => parseRich(html).map(s => s.t).join('').replace(/ /g, ' ');

// ---------------------------------------------------------------- LCD screen
const SW = 1280, SH = 960;
const PHOTO_W = 260, PHOTO_H = 325;

function createScreen(photo){
  const canvas = document.createElement('canvas');
  canvas.width = SW; canvas.height = SH;
  const ctx = canvas.getContext('2d');
  const tex = canvasTexture(canvas);

  const scan = document.createElement('canvas'); scan.width = 4; scan.height = 4;
  const sx = scan.getContext('2d'); sx.fillStyle = 'rgba(0,0,0,.028)'; sx.fillRect(0, 0, 4, 2);
  const scanPattern = ctx.createPattern(scan, 'repeat');

  let snap = urna.snapshot();
  const anim = {digit: [-1e9, -1e9], card: -1e9, err: -1e9, fim: -1e9};
  let dirtyUntil = Infinity, lastBlink = null;

  const font = (w, s, f, style = '') => { ctx.font = `${style} ${w} ${s}px ${f}`; };
  const rrect = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

  function richLine(segs, cx, y, size, color, boldColor = color){
    let total = 0;
    for(const s of segs){ font(s.b ? 700 : 400, size, F.sans); s.w = ctx.measureText(s.t).width; total += s.w; }
    let x = cx - total/2;
    ctx.textAlign = 'left';
    for(const s of segs){
      font(s.b ? 700 : 400, size, F.sans); ctx.fillStyle = s.b ? boldColor : color;
      ctx.fillText(s.t, x, y); x += s.w;
    }
  }

  function wrapRich(segs, size, maxW){
    const toks = [];
    for(const s of segs) for(const t of s.t.split(/( )/)) if(t) toks.push({t, b: s.b});
    const lines = [[]]; let w = 0;
    const trim = l => { while(l.length && l[l.length-1].t === ' ') l.pop(); };
    for(const tk of toks){
      font(tk.b ? 700 : 400, size, F.sans);
      const tw = ctx.measureText(tk.t).width;
      const cur = lines[lines.length-1];
      if(tk.t === ' ' && !cur.length) continue;
      if(tk.t !== ' ' && cur.length && w + tw > maxW){ trim(cur); lines.push([]); w = 0; }
      lines[lines.length-1].push({...tk}); w += tw;
    }
    lines.forEach(trim);
    return lines;
  }

  function star(cx, cy, r){
    ctx.beginPath();
    for(let i = 0; i < 10; i++){
      const a = -Math.PI/2 + i * Math.PI/5, rr = i % 2 ? r * .42 : r;
      ctx.lineTo(cx + Math.cos(a)*rr, cy + Math.sin(a)*rr);
    }
    ctx.closePath(); ctx.fill();
  }

  function draw(now){
    const s = snap;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;

    let g = ctx.createLinearGradient(0, 0, 0, SH);
    g.addColorStop(0, '#f4f7f1'); g.addColorStop(1, '#eaefe6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, SW, SH);

    // header
    ctx.fillStyle = '#1d2b22'; ctx.fillRect(0, 0, SW, 100);
    ctx.textBaseline = 'middle'; ctx.fillStyle = '#eef2ea';
    font(600, 46, F.oswald); spaced(ctx, 'PRESIDENTE', 48, 52, 6);
    ctx.globalAlpha = .75; font(600, 36, F.mono); ctx.textAlign = 'right';
    ctx.fillText('2º TURNO', SW - 48, 52);
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = '#5c6b5f'; font(500, 34, F.sans); ctx.fillText('Seu voto para', 48, 168);

    // número + digit boxes
    ctx.fillStyle = '#33433a'; font(600, 38, F.sans); ctx.textBaseline = 'middle';
    ctx.fillText('Número:', 48, 285);
    const bx0 = 48 + ctx.measureText('Número:').width + 32;
    for(let i = 0; i < 2; i++){
      const x = bx0 + i * 138, y = 210, w = 112, h = 150;
      ctx.fillStyle = '#fbfdfa'; rrect(x, y, w, h, 10); ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = '#243a2c'; ctx.stroke();
      const d = s.digits[i];
      if(d !== undefined){
        const k = easeOut(clamp01((now - anim.digit[i]) / 180));
        ctx.save(); ctx.translate(x + w/2, y + h/2 + 5); ctx.scale(.7 + .3*k, .7 + .3*k);
        ctx.globalAlpha = .3 + .7*k; ctx.fillStyle = '#15251b';
        font(700, 100, F.mono); ctx.textAlign = 'center'; ctx.fillText(d, 0, 0);
        ctx.restore();
      }else if(i === s.digits.length && s.state === 'voting' && Math.floor(now / 500) % 2 === 0){
        ctx.fillStyle = '#7e8a80'; rrect(x + w/2 - 24, y + h/2 - 4, 48, 8, 4); ctx.fill();
      }
    }
    ctx.textBaseline = 'alphabetic';

    // candidate card
    if(s.state === 'ready' || s.state === 'fim'){
      const k = easeOut(clamp01((now - anim.card) / 350));
      ctx.save(); ctx.globalAlpha = k; ctx.translate(0, (1 - k) * 22);

      const lab = (t, x, y) => { ctx.fillStyle = '#5c6b5f'; font(500, 30, F.sans); ctx.fillText(t, x, y); };
      const val = (t, x, y, w = 700, size = 58) => { ctx.fillStyle = '#15251b'; font(w, size, F.sans); ctx.fillText(t, x, y); };
      lab('Nome:', 48, 450);    val('LULA', 260, 452);
      lab('Partido:', 48, 528); ctx.fillStyle = '#c1271f'; star(282, 512, 24); val('PT', 318, 530);
      lab('Vice-Presidente:', 48, 606); val('GERALDO ALCKMIN', 48, 662, 600, 44);

      const px = SW - 48 - PHOTO_W, py = 140;
      ctx.save(); rrect(px, py, PHOTO_W, PHOTO_H, 8); ctx.clip();
      if(photo) ctx.drawImage(photo, px, py, PHOTO_W, PHOTO_H);
      else { ctx.fillStyle = '#dfe6dd'; ctx.fillRect(px, py, PHOTO_W, PHOTO_H); }
      ctx.restore();
      ctx.lineWidth = 5; ctx.strokeStyle = '#243a2c'; rrect(px, py, PHOTO_W, PHOTO_H, 8); ctx.stroke();

      ctx.setLineDash([12, 9]); ctx.lineWidth = 3; ctx.strokeStyle = '#b6c0b6';
      ctx.beginPath(); ctx.moveTo(48, 728); ctx.lineTo(SW - 48, 728); ctx.stroke(); ctx.setLineDash([]);

      ctx.fillStyle = '#3a4a40'; font(500, 34, F.sans); ctx.fillText('Aperte a tecla:', 48, 786);
      const keyLine = (kw, color, rest, y) => {
        font(600, 38, F.oswald); ctx.fillStyle = color;
        const w = spaced(ctx, kw, 48, y, 2);
        font(500, 34, F.sans); ctx.fillStyle = '#3a4a40'; ctx.fillText(rest, 48 + w, y);
      };
      keyLine('CONFIRMA', '#15692c', ' para CONFIRMAR este voto', 842);
      keyLine('CORRIGE',  '#b85f0c', ' para REINICIAR este voto', 898);
      ctx.restore();
    }

    if(s.state === 'voting'){
      ctx.fillStyle = '#7a857c'; font(400, 34, F.sans, 'italic');
      ctx.fillText('Aguardando os números do seu candidato…', 48, SH - 64);
    }

    // error overlay
    if(s.state === 'error'){
      const t = now - anim.err;
      ctx.save(); ctx.globalAlpha = easeOut(clamp01(t / 250));
      g = ctx.createLinearGradient(0, 0, 0, SH);
      g.addColorStop(0, '#fff0ef'); g.addColorStop(1, '#ffe2e0');
      ctx.fillStyle = g; ctx.fillRect(0, 0, SW, SH);

      const lines = wrapRich(parseRich(s.err.msg), 42, 960);
      const lineH = 60, total = 130 + 24 + 88 + 30 + lines.length * lineH + 36 + 76;
      let y = (SH - total) / 2;

      // shake: 0 -9 8 -6 4 0 (css keyframes, scaled up)
      const ks = [0, -9, 8, -6, 4, 0], p = clamp01(t / 500) * 5, i0 = Math.floor(Math.min(p, 4.999));
      const dx = lerp(ks[i0], ks[i0 + 1], p - i0) * 2.6;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      font(400, 112, F.emoji); ctx.fillStyle = '#000'; ctx.fillText('🚫', SW/2 + dx, y + 65);
      y += 130 + 24;

      font(700, 78, F.oswald); ctx.fillStyle = '#c1271f';
      spaced(ctx, s.err.title.toUpperCase(), SW/2, y + 44, 3, 'center');
      y += 88 + 30;

      for(const l of lines){ richLine(l, SW/2, y + lineH/2, 42, '#7a2420', '#5a1512'); y += lineH; }
      y += 36;

      ctx.fillStyle = '#c1271f'; rrect(SW/2 - 110, y, 220, 76, 38); ctx.fill();
      ctx.fillStyle = '#fff'; font(700, 46, F.mono);
      spaced(ctx, '1  3', SW/2, y + 40, 12, 'center');
      ctx.restore();
    }

    // FIM overlay
    if(s.state === 'fim'){
      const t = now - anim.fim;
      ctx.save(); ctx.globalAlpha = easeOut(clamp01(t / 250));
      g = ctx.createLinearGradient(0, 0, 0, SH);
      g.addColorStop(0, '#eef7f0'); g.addColorStop(1, '#dff0e4');
      ctx.fillStyle = g; ctx.fillRect(0, 0, SW, SH);
      ctx.restore();

      const k = clamp01(t / 520), sc = 2.4 - 1.4 * easeBack(k);
      ctx.save(); ctx.translate(SW/2, 390); ctx.scale(sc, sc); ctx.globalAlpha = clamp01(k * 3);
      ctx.textBaseline = 'middle'; font(700, 300, F.oswald);
      ctx.fillStyle = 'rgba(255,255,255,.7)'; spaced(ctx, 'FIM', 0, 6, 26, 'center');
      ctx.fillStyle = '#15692c'; spaced(ctx, 'FIM', 0, 0, 26, 'center');
      ctx.restore();

      ctx.save(); ctx.globalAlpha = clamp01((t - 250) / 300); ctx.textBaseline = 'middle';
      richLine(parseRich('Seu voto para <b>LULA (13)</b> foi computado.'), SW/2, 615, 42, '#1f5733');
      font(600, 34, F.sans);
      const bw = ctx.measureText('Votar novamente').width + 90;
      ctx.lineWidth = 4; ctx.strokeStyle = '#15692c'; rrect(SW/2 - bw/2, 710, bw, 80, 40); ctx.stroke();
      ctx.fillStyle = '#15692c'; ctx.textAlign = 'center'; ctx.fillText('Votar novamente', SW/2, 752);
      ctx.restore();
    }

    ctx.fillStyle = scanPattern; ctx.fillRect(0, 0, SW, SH);
  }

  return {
    texture: tex,
    get state(){ return snap.state; },
    get fimAt(){ return anim.fim; },
    update(next, now){
      if(next.digits.length > snap.digits.length) anim.digit[next.digits.length - 1] = now;
      if(next.state !== snap.state){
        if(next.state === 'ready') anim.card = now;
        if(next.state === 'error') anim.err = now;
        if(next.state === 'fim')   anim.fim = now;
      }
      snap = next;
      dirtyUntil = now + 900;
    },
    invalidate(){ dirtyUntil = Infinity; },
    tick(now){
      const blink = snap.state === 'voting' ? Math.floor(now / 500) % 2 : -1;
      if(now > dirtyUntil && blink === lastBlink) return;
      if(dirtyUntil === Infinity) dirtyUntil = 0;
      lastBlink = blink;
      draw(now);
      tex.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- scene
async function boot(){
  if(!root.classList.contains('want-3d') || !urna) throw new Error('3D mode not requested');

  const [, photo] = await Promise.all([loadFonts(), loadPhoto('lula.jpg', PHOTO_W, PHOTO_H)]);

  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Urna eletrônica em 3D. Use as teclas numéricas, Enter para confirmar e Backspace para corrigir.');
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.75;

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 1000);

  // lights
  const sun = new THREE.DirectionalLight(0xfff3e2, 2.4);
  sun.position.set(-22, 48, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {left: -36, right: 36, top: 36, bottom: -36, near: 5, far: 140});
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xd8e4ff, 0.7);
  rim.position.set(30, 20, -25);
  scene.add(rim);

  // ground: transparent, only catches shadows so the page backdrop shows through
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI/2),
    new THREE.ShadowMaterial({opacity: 0.42}));
  ground.receiveShadow = true;
  scene.add(ground);
  {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(128, 128, 20, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(62, 44).rotateX(-Math.PI/2),
      new THREE.MeshBasicMaterial({map: canvasTexture(c), transparent: true, depthWrite: false}));
    blob.position.y = 0.02;
    scene.add(blob);
  }

  // ----- body: side profile (z = front/back, y = height) extruded across the width
  const W = 44, LIFT = 0.45;            // width; feet height
  const FRONT_H = 4.4, BACK_H = 12.4, HALF_D = 13;
  const profile = roundedPoly([
    new THREE.Vector2( HALF_D, LIFT),
    new THREE.Vector2( HALF_D, LIFT + FRONT_H),
    new THREE.Vector2(-HALF_D, LIFT + BACK_H),
    new THREE.Vector2(-HALF_D, LIFT),
  ], [1.0, 1.6, 1.6, 1.0]);
  const BEVEL = 0.9;
  const bodyGeo = new THREE.ExtrudeGeometry(profile, {
    depth: W - 2*BEVEL, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL,
    bevelOffset: -BEVEL, bevelSegments: 6, curveSegments: 20,
  });
  bodyGeo.rotateY(-Math.PI/2);
  bodyGeo.translate((W - 2*BEVEL) / 2, 0, 0);
  bodyGeo.computeVertexNormals();
  const plastic = new THREE.MeshPhysicalMaterial({color: 0xdcd6c6, roughness: 0.58, clearcoat: 0.2, clearcoatRoughness: 0.5});
  const urnaGroup = new THREE.Group();
  const body = new THREE.Mesh(bodyGeo, plastic);
  body.castShadow = body.receiveShadow = true;
  urnaGroup.add(body);

  const darkPlastic = new THREE.MeshStandardMaterial({color: 0x2b2c2f, roughness: 0.6});
  for(const [x, z] of [[-18, -10], [18, -10], [-18, 10], [18, 10]]){
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, LIFT, 20), darkPlastic);
    foot.position.set(x, LIFT/2, z);
    urnaGroup.add(foot);
  }

  // ----- panel: a group lying on the sloped top (local XZ = surface, +Y = out, -Z = toward the back)
  const slope = Math.atan2(BACK_H - FRONT_H, 2*HALF_D);
  const panel = new THREE.Group();
  panel.position.set(0, LIFT + (FRONT_H + BACK_H) / 2, 0);
  panel.rotation.x = slope;
  urnaGroup.add(panel);

  // screen: dark bezel, LCD canvas, glass on top
  const screen = createScreen(photo);
  screen.texture.anisotropy = maxAniso;
  const SCR = {x: -8.4, z: -1.0, w: 19.6, d: 14.7};
  const bezel = new THREE.Mesh(new RoundedBoxGeometry(SCR.w + 2.6, 0.9, SCR.d + 2.6, 4, 0.5), darkPlastic);
  bezel.position.set(SCR.x, 0.05, SCR.z);
  bezel.castShadow = bezel.receiveShadow = true;
  panel.add(bezel);
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(SCR.w, SCR.d).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({map: screen.texture, toneMapped: false}));
  lcd.position.set(SCR.x, 0.51, SCR.z);
  panel.add(lcd);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(SCR.w, SCR.d).rotateX(-Math.PI/2),
    new THREE.MeshPhysicalMaterial({color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.14, depthWrite: false}));
  glass.position.set(SCR.x, 0.53, SCR.z);
  panel.add(glass);

  // keypad
  const KEY_H = 1.0, PLATE_T = 0.3, PRESS = 0.32;
  const KEY_TOP = PLATE_T + KEY_H;
  const labels = [];
  const keys = [];

  function labelTexture(w, d, draw){
    const ppu = 110, c = document.createElement('canvas');
    c.width = Math.round(w * ppu); c.height = Math.round(d * ppu);
    const tex = canvasTexture(c); tex.anisotropy = maxAniso;
    const redraw = () => {
      const x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      x.textAlign = 'center'; x.textBaseline = 'middle';
      draw(x, c.width, c.height);
      tex.needsUpdate = true;
    };
    redraw(); labels.push(redraw);
    return tex;
  }

  function addKey({x, z, w, d, color, text, ink, size, action, code}){
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const cap = new THREE.Mesh(new RoundedBoxGeometry(w, KEY_H, d, 4, 0.32),
      new THREE.MeshPhysicalMaterial({color, roughness: 0.38, clearcoat: 0.3, clearcoatRoughness: 0.35}));
    cap.position.y = PLATE_T + KEY_H/2;
    cap.castShadow = cap.receiveShadow = true;
    const map = labelTexture(w - .5, d - .5, (x, cw, ch) => {
      x.fillStyle = ink;
      let px = Math.round(ch * size.k);
      x.font = `${size.w} ${px}px ${size.f}`;
      const fit = cw * 0.8 / (x.measureText(text).width + cw * 0.012 * (text.length - 1));
      if(fit < 1){ px = Math.floor(px * fit); x.font = `${size.w} ${px}px ${size.f}`; }
      if(text.length > 1) spaced(x, text, cw/2, ch/2 + 2, cw * 0.012, 'center');
      else x.fillText(text, cw/2, ch/2 + ch*0.04);
    });
    const label = new THREE.Mesh(new THREE.PlaneGeometry(w - .5, d - .5).rotateX(-Math.PI/2),
      new THREE.MeshStandardMaterial({map, transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2}));
    label.position.y = KEY_TOP + 0.004;
    g.add(cap, label);
    panel.add(g);
    keys.push({g, action, code, x, z, w, d, held: false, pressT: -1e9, depth: 0});
  }

  const KP = {x: 12.2, z: -0.4};
  const NUM_W = 3.4, NUM_D = 2.5, GAP = 0.8, FN_D = 3.0, FN_GAP = 1.3;
  const gridW = 3*NUM_W + 2*GAP;
  const gridD = 4*NUM_D + 3*GAP + FN_GAP + FN_D;
  const z0 = KP.z - gridD/2;
  const numStyle = {w: 600, k: 0.66, f: F.sans};
  const layout = [['1','2','3'], ['4','5','6'], ['7','8','9'], [null,'0',null]];
  layout.forEach((row, r) => row.forEach((n, c) => {
    if(n === null) return;
    addKey({
      x: KP.x - gridW/2 + NUM_W/2 + c*(NUM_W + GAP), z: z0 + NUM_D/2 + r*(NUM_D + GAP),
      w: NUM_W, d: NUM_D, color: 0x1e1f22, text: n, ink: '#f1efe8', size: numStyle,
      action: () => urna.pressDigit(n), code: n,
    });
  }));
  const fnZ = z0 + 4*NUM_D + 3*GAP + FN_GAP + FN_D/2;
  const fnStyle = {w: 700, k: 0.3, f: F.sans};
  const fns = [
    {w: 3.55, color: 0xf3f0e7, text: 'BRANCO',   ink: '#3d3a31', action: () => urna.branco()},
    {w: 3.55, color: 0xe27c19, text: 'CORRIGE',  ink: '#ffffff', action: () => urna.corrige(),  code: 'Backspace'},
    {w: 4.1,  color: 0x1f8f3d, text: 'CONFIRMA', ink: '#ffffff', action: () => urna.confirma(), code: 'Enter'},
  ];
  const fnGap = (gridW - fns.reduce((a, f) => a + f.w, 0)) / 2;
  let fx = KP.x - gridW/2;
  for(const f of fns){
    addKey({...f, x: fx + f.w/2, z: fnZ, d: FN_D, size: fnStyle});
    fx += f.w + fnGap;
  }
  const plate = new THREE.Mesh(new RoundedBoxGeometry(gridW + 2.2, PLATE_T * 2, gridD + 2.2, 4, 0.3), darkPlastic);
  plate.position.set(KP.x, 0, KP.z);
  plate.receiveShadow = true;
  panel.add(plate);

  // decals: brand strip, LED, maker's mark
  function decal(w, d, x, z, draw){
    const map = labelTexture(w, d, draw);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI/2),
      new THREE.MeshStandardMaterial({map, transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2}));
    m.position.set(x, 0.01, z);
    m.receiveShadow = true;
    panel.add(m);
  }
  decal(20, 1.6, SCR.x, -11.0, (x, cw, ch) => {
    x.textAlign = 'left'; x.font = `600 ${ch*0.62}px ${F.oswald}`;
    x.fillStyle = '#7a7461'; let w = spaced(x, 'JUSTIÇA ', 0, ch/2, ch*0.14);
    x.fillStyle = '#4a4538'; w += spaced(x, 'ELEITORAL', w, ch/2, ch*0.14);
    x.fillStyle = '#7a7461'; spaced(x, '  ·  BRASIL', w, ch/2, ch*0.14);
  });
  decal(6, 1.4, KP.x + 3.4, -11.0, (x, cw, ch) => {
    x.textAlign = 'left'; x.font = `600 ${ch*0.5}px ${F.sans}`; x.fillStyle = '#7a7461';
    spaced(x, 'LIBERADA', 0, ch/2 + 1, ch*0.12);
  });
  decal(14, 1.4, SCR.x - 3, 10.9, (x, cw, ch) => {
    x.textAlign = 'left'; x.font = `700 ${ch*0.62}px ${F.oswald}`;
    x.fillStyle = '#9a937e'; let w = spaced(x, 'vote', 0, ch/2, ch*0.06);
    x.fillStyle = '#2f9a4b'; w += spaced(x, '13', w + ch*0.06, ch/2, ch*0.06) + ch*0.12;
    x.fillStyle = '#9a937e'; spaced(x, '.pt', w, ch/2, ch*0.06);
  });
  const ledMat = new THREE.MeshStandardMaterial({color: 0x1d8a37, emissive: 0x3cff6a, emissiveIntensity: 1.6, roughness: 0.25});
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 12), ledMat);
  led.position.set(KP.x - 0.4, 0.05, -11.0);
  panel.add(led);

  scene.add(urnaGroup);

  // ----- camera framing
  // landscape frames the whole machine; portrait (phones) frames just screen + keypad
  urnaGroup.updateMatrixWorld(true);
  const boxCorners = b => {
    const out = [];
    for(const x of [b.min.x, b.max.x]) for(const y of [b.min.y, b.max.y]) for(const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z));
    return out;
  };
  const wholeBox = new THREE.Box3().setFromObject(urnaGroup);
  const faceBox  = new THREE.Box3().setFromObject(bezel).union(new THREE.Box3().setFromObject(plate));
  const framing = {
    whole: {corners: boxCorners(wholeBox), target: wholeBox.getCenter(new THREE.Vector3()).add(new THREE.Vector3(0, -1.5, 0)), margin: 0.94},
    face:  {corners: boxCorners(faceBox),  target: faceBox.getCenter(new THREE.Vector3()), margin: 0.985},
  };
  let frameMode = framing.whole;
  const target = frameMode.target.clone();
  const v = new THREE.Vector3();
  const sph = new THREE.Spherical();
  const dirOf = (phi, theta) => new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

  function fitDistance(dir){
    let lo = 5, hi = 600;
    for(let i = 0; i < 26; i++){
      const mid = (lo + hi) / 2;
      camera.position.copy(target).addScaledVector(dir, mid);
      camera.lookAt(target); camera.updateMatrixWorld();
      const m = frameMode.margin;
      const ok = frameMode.corners.every(c => { v.copy(c).project(camera); return Math.abs(v.x) <= m && Math.abs(v.y) <= m; });
      ok ? (hi = mid) : (lo = mid);
    }
    return hi;
  }

  const rest = {phi: 0, theta: 0, r: 0};
  function computeRest(){
    const portrait = camera.aspect < 1;
    frameMode = portrait ? framing.face : framing.whole;
    target.copy(frameMode.target);
    controls.target.copy(target);
    rest.phi   = deg(portrait ? 30 : 46);
    rest.theta = deg(portrait ? 0 : -12);
    const saved = camera.position.clone();
    rest.r = fitDistance(dirOf(rest.phi, rest.theta));
    camera.position.copy(saved);
    controls.minDistance = rest.r * 0.4;
    controls.maxDistance = rest.r * 1.6;
  }

  // ----- input: keys + screen are hit-tested on the panel planes, so the gaps
  // between keys still count (bigger tap targets on phones).
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const inv = new THREE.Matrix4();
  const localRay = new THREE.Ray();

  function hitTest(e){
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    inv.copy(panel.matrixWorld).invert();
    localRay.copy(raycaster.ray).applyMatrix4(inv);
    const at = h => {
      if(Math.abs(localRay.direction.y) < 1e-6) return null;
      const t = (h - localRay.origin.y) / localRay.direction.y;
      return t > 0 ? localRay.at(t, new THREE.Vector3()) : null;
    };
    const p = at(KEY_TOP);
    if(p){
      const k = keys.find(k => Math.abs(p.x - k.x) <= k.w/2 + GAP/2 && Math.abs(p.z - k.z) <= k.d/2 + GAP/2);
      if(k) return {key: k};
    }
    const q = at(0.51);
    if(q && Math.abs(q.x - SCR.x) <= SCR.w/2 && Math.abs(q.z - SCR.z) <= SCR.d/2) return {screen: true};
    return null;
  }

  const press = (k, now) => { k.held = true; k.pressT = now; };
  let pointerKey = null;

  // registered before OrbitControls so a key press can veto the orbit drag
  canvas.addEventListener('pointerdown', e => {
    if(introT < 1) return;
    const hit = hitTest(e);
    if(!hit) return;
    controls.enabled = false;
    if(hit.key){ pointerKey = hit.key; press(hit.key, performance.now()); hit.key.action(); }
    else if(hit.screen && screen.state === 'fim') urna.reset();
  });
  const release = () => {
    if(pointerKey){ pointerKey.held = false; pointerKey = null; }
    controls.enabled = introT >= 1;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  canvas.addEventListener('pointermove', e => {
    if(e.buttons) return;
    const hit = hitTest(e);
    canvas.style.cursor = hit && (hit.key || (hit.screen && screen.state === 'fim')) ? 'pointer' : 'grab';
  });

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.6;
  controls.minPolarAngle = deg(8);
  controls.maxPolarAngle = deg(80);
  controls.minAzimuthAngle = deg(-65);
  controls.maxAzimuthAngle = deg(65);
  controls.enabled = false;

  let interacting = false, lastInteraction = 0;
  controls.addEventListener('start', () => { interacting = true; canvas.style.cursor = 'grabbing'; });
  controls.addEventListener('end',   () => { interacting = false; lastInteraction = performance.now(); canvas.style.cursor = 'grab'; });

  // physical keyboard: index.html already handles the logic; we only animate the keys
  const keyByCode = Object.fromEntries(keys.filter(k => k.code).map(k => [k.code, k]));
  window.addEventListener('keydown', e => {
    const k = keyByCode[e.key];
    if(k && !e.repeat) press(k, performance.now());
  });
  window.addEventListener('keyup', e => {
    const k = keyByCode[e.key];
    if(k) k.held = false;
    // Enter on the FIM screen starts over (ignore the keyup of the confirming press)
    if(e.key === 'Enter' && screen.state === 'fim' && performance.now() - screen.fimAt > 600) urna.reset();
  });

  window.addEventListener('urna:change', e => {
    screen.update(e.detail, performance.now());
    announce(e.detail);
  });
  document.fonts.addEventListener?.('loadingdone', () => { labels.forEach(f => f()); screen.invalidate(); });

  // ----- size + loop
  stage.prepend(canvas);
  function resize(){
    const w = stage.clientWidth, h = stage.clientHeight;
    if(!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    computeRest();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  // intro: swing in from the side
  let introT = 0;
  const introFrom = {phi: deg(68), theta: deg(-58), k: 1.3};
  const placeCamera = (phi, theta, r) => {
    camera.position.copy(target).addScaledVector(dirOf(phi, theta), r);
    camera.lookAt(target);
  };
  placeCamera(introFrom.phi, introFrom.theta, rest.r * introFrom.k);

  const clock = new THREE.Clock();
  function frame(stepDt){
    const dt = stepDt ?? Math.min(clock.getDelta(), 0.05);
    const now = performance.now();

    if(introT < 1){
      introT = Math.min(1, introT + dt / 1.9);
      const k = easeInOut(introT);
      placeCamera(lerp(introFrom.phi, rest.phi, k), lerp(introFrom.theta, rest.theta, k), rest.r * lerp(introFrom.k, 1, k));
      if(introT >= 1){ controls.enabled = true; lastInteraction = now; }
    }else{
      // drift back to the resting view after the user lets go
      if(!interacting && now - lastInteraction > 3500){
        sph.setFromVector3(v.copy(camera.position).sub(target));
        const k = 1 - Math.exp(-dt * 1.6);
        placeCamera(lerp(sph.phi, rest.phi, k), lerp(sph.theta, rest.theta, k), lerp(sph.radius, rest.r, k));
      }
      controls.update();
    }

    for(const k of keys){
      const down = k.held || now - k.pressT < 110;
      k.depth += ((down ? PRESS : 0) - k.depth) * Math.min(1, dt * (down ? 40 : 18));
      k.g.position.y = -k.depth;
    }

    const ledLive = screen.state === 'voting' || screen.state === 'ready';
    ledMat.emissiveIntensity = ledLive ? 1.0 + 0.8 * (0.5 + 0.5 * Math.cos(now / 2400 * Math.PI * 2)) : 0.25;

    screen.tick(now);
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(() => frame());
  // ?debug: step frames by hand (headless/background tabs don't get rAF)
  if(/[?&]debug\b/.test(location.search)) window.__urna3d = {frame, resize, camera, controls};

  root.classList.add('is-3d');
}

function roundedPoly(pts, radii){
  const s = new THREE.Shape(), n = pts.length;
  for(let i = 0; i < n; i++){
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const p1 = p.clone().add(a.clone().sub(p).normalize().multiplyScalar(radii[i]));
    const p2 = p.clone().add(b.clone().sub(p).normalize().multiplyScalar(radii[i]));
    i === 0 ? s.moveTo(p1.x, p1.y) : s.lineTo(p1.x, p1.y);
    s.quadraticCurveTo(p.x, p.y, p2.x, p2.y);
  }
  s.closePath();
  return s;
}

function announce(s){
  if(!live || !root.classList.contains('is-3d')) return;
  live.textContent =
    s.state === 'ready' ? 'LULA, PT. Aperte CONFIRMA para confirmar ou CORRIGE para reiniciar.' :
    s.state === 'error' ? `${s.err.title}. ${plain(s.err.msg)}` :
    s.state === 'fim'   ? 'FIM. Seu voto para LULA (13) foi computado. Aperte Enter para votar novamente.' :
    s.digits.length     ? `Número: ${s.digits.join(' ')}` : '';
}

boot().catch(err => {
  console.error('[urna3d]', err);
  root.classList.remove('want-3d', 'is-3d');
});
