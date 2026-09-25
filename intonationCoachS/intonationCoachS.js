'use strict';
const SR = 16000;
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const sb = document.getElementById('sb');
const sbin = document.getElementById('sbin');
const $ = id => document.getElementById(id);

// メモリ削減のため、音声本体は Int16（PK_SCALE 倍したスケール整数）で保持する。
// Web Audio の AudioBuffer が要求する Float32 は、再生・書き出し時に必要な
// 区間ぶんだけ都度その場で変換して作る（常時Float32で全体を持たない）。
const PK_SCALE = 32767;
function clampI16(v) { return Math.max(-32768, Math.min(32767, Math.round(v))); }

let samples = null;			// Int16Array（±PK_SCALEスケール）。表示専用・書き換えなし
let levels = [];
let duration = 0;
let viewStart = 0;
let viewDur = 1;
let handles = [];			// {t, id} 昇順。先頭/末尾は固定
let sel = 0;					// 選択中ハンドルの index
let audioCtx = null;
let src = null;
let playAt = 0;
let playFrom = 0;
let playTo = 0;
let playing = false;
let followAnchor = 0.5;
let scrollingActive = true;
let uid = 1;

/* ---------- 読み込み → モノラル化 → 16kHz → Int16化 ---------- */
$('file').addEventListener('change', async e => {
	const f = e.target.files[0];
	if (!f)  return;
	try {
		const ab = await readFileWithProgress(f, (percent, loaded, total) => {
			$('meta').textContent = `ファイル読み込み中… ${percent}%`;
		});

		$('meta').textContent = 'デコード中… （読み込み+αの時間がかかります）';
		const tmp = new (window.AudioContext || window.webkitAudioContext)();
		let decoded = await tmp.decodeAudioData(ab);
		tmp.close();

		$('meta').textContent = 'モノラル／16kHzに変換中… （あともう少しです）';
		const len = Math.max(1, Math.ceil(decoded.duration * SR));
		// OfflineAudioContext がモノラル・ダウンミックスとリサンプリングを行う
		const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, len, SR);
		const s = off.createBufferSource();
		s.buffer = decoded; s.connect(off.destination);
		s.start();
		const out = await off.startRendering();
		decoded = null;										// 元データはもう不要

		$('meta').textContent = 'Int16Arrayに変換中…';
		// Float32(-1..1) → Int16(±PK_SCALE) へ変換して保持する。
		// out（Float32のAudioBuffer）はこの変換が終われば不要になるので、
		// どこにも代入せず（module変数に持たせず）ローカル参照のまま関数を抜けさせ、GCに任せる。
		const f32 = out.getChannelData(0);
		const n = f32.length;
		const samplesI16 = new Int16Array(n);
		for (let i = 0; i < n; i++) {
			samplesI16[i] = clampI16(f32[i] * PK_SCALE);
		}
		samples = samplesI16;

		$('meta').textContent = 'Waveform Pyramid生成中…';
		duration = samples.length / SR;
		levels = buildPeaks(samples);					// waveform pyramid（LoD）生成
		handles = [{t:0, id:uid++}, {t:duration, id:uid++}];
		sel = 0;
		viewStart = 0; viewDur = duration;

		for (const b of ['playStop','zin','zout','zall']) $(b).disabled = false;

		$('meta').textContent = `${trimFilename(f.name, 15)} ／ ${fmt(duration)}`;

		layout(); renderList();
	} catch (err) {
		$('meta').textContent = 'この音声は読み込めません。別の形式のファイルを試してください。';
		console.error(err);
	}
});

function trimFilename(str, n) {
	const noc = Math.floor((n - 3) / 2);
	const additional = ((n % 2) == 0) ? 1 : 0;
	return str.substr(0, noc+additional) + '...' + str.substr(-noc);
}

async function readFileWithProgress(file, onProgress) {
	const totalSize = file.size;	// 全体サイズ（バイト）
	let loadedSize = 0;				// 読み込み済みサイズ
	const stream = file.stream();
	const reader = stream.getReader();
	const chunks = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done)  break;				// 読み込み完了
		chunks.push(value);
		loadedSize += value.byteLength;
		if (onProgress && totalSize > 0) {
			const percent = Math.round((loadedSize / totalSize) * 100);
			onProgress(percent, loadedSize, totalSize);
		}
	}
	const concatenatedBuffer = new Uint8Array(loadedSize);
	let offset = 0;
	for (const chunk of chunks) {
		concatenatedBuffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return concatenatedBuffer.buffer; // 最終的な ArrayBuffer を返す
}

/* ---------- Waveform pyramid（LoD）の生成 ---------- */
// x は既に Int16（±PK_SCALEスケール）なので、ここでは追加のスケーリングをせず、
// そのままmin/maxを取るだけでよい（PK_SCALEを再度掛けるとオーバーフローするので注意）。
function buildPeaks(x) {
	const L = [];
	let step = 256
	let n = Math.ceil(x.length/step);
	let mn = new Int16Array(n);
	let mx = new Int16Array(n);
	for (let i = 0; i < n; i++) {
		const a = i * step;
		const b = Math.min(x.length, a + step);
		let lo = 32767;
		let hi = -32768;
		for (let j = a; j < b; j++) {
			const v=x[j];
			if (v < lo)  lo=v;
			if (v > hi)  hi=v;
		}
		if (lo > hi) {
			lo = 0;
			hi = 0;
		}
		mn[i] = lo;
		mx[i] = hi;
	}
	L.push({step, mn, mx});
	while (L[L.length-1].mn.length > 4) {
		const p = L[L.length-1];
		const f = 8;
		const n2 = Math.ceil(p.mn.length / f);
		const m2 = new Int16Array(n2);
		const x2 = new Int16Array(n2);
		for (let i = 0; i < n2; i++) {
			const a = i * f;
			const b = Math.min(p.mn.length, a + f);
			let lo = 32767;
			let hi = -32768;
			for (let j = a; j < b; j++) {
				if (p.mn[j] < lo)  lo = p.mn[j];
				if (p.mx[j] > hi)  hi = p.mx[j];
			}
			if (lo > hi) {
				lo=0;
				hi=0;
			}
			m2[i] = lo;
			x2[i] = hi;
		}
		L.push({step: p.step * f, mn: m2, mx: x2});
	}
	return L;
}

/* ---------- 表示範囲 ---------- */
const MINDUR = 0.004;
const RUL = 20;
function clampView() {
	viewDur = Math.min(duration, Math.max(MINDUR, viewDur));
	viewStart = Math.min(duration - viewDur, Math.max(0, viewStart));
}
const t2x = t => (t - viewStart) / viewDur * cv.clientWidth;
const x2t = x => viewStart + x / cv.clientWidth * viewDur;

function zoomAt(factor, anchorX) {
	const at = x2t(anchorX);
	const frac = anchorX / cv.clientWidth;
	viewDur *= factor; 
	viewDur = Math.min(duration, Math.max(MINDUR, viewDur));
	viewStart = at - frac * viewDur;
	clampView();
	layout();
}
// 指定した時刻tが画面中央に来るようにズームする（ファイルの先頭/末尾付近では
// clampViewにより中央にしきれず、そちら側に寄った状態になる）。
function zoomAtTime(factor, t) {
	viewDur = Math.min(duration, Math.max(MINDUR, viewDur * factor));
	viewStart = t - viewDur / 2;
	clampView();
	layout();
}
// 拡大縮小ボタンの基準にする時刻。再生中はカーソル（再生位置）の時刻、
// 再生していなければ現在選択中のハンドル（開いた直後は先頭ハンドル＝0秒）の時刻を使う。
function zoomAnchorTime() {
	if (playing) {
		return Math.min(playTo, playFrom + (audioCtx.currentTime - playAt));
	}
	return (handles.length > 0) ? handles[sel].t : x2t(cv.clientWidth / 2);
}
$('zin').onclick  = () => zoomAtTime(1/1.6, zoomAnchorTime());
$('zout').onclick = () => zoomAtTime(1.6,   zoomAnchorTime());
$('zall').onclick = () => { viewStart = 0; viewDur = duration; layout(); };

/* ---------- スクロールバー ---------- */
let sbSelfChange = false;
const SB_MAX_W = 6000000;			// ブラウザの要素幅上限を避けるための安全な上限
function syncScrollbar(){
	const vw = sb.clientWidth;
	const total = Math.min(SB_MAX_W, duration > 0 ? vw * (duration / viewDur) : vw);
	sbin.style.width = total + 'px';
	sbSelfChange = true;
	sb.scrollLeft = total * (viewStart / (duration || 1));
	// scroll イベントが飛んでこなかった場合(値が変わらず発火しない等)に備えたフォールバック
	requestAnimationFrame(() => { sbSelfChange = false; });
}
sb.addEventListener('scroll', () => {
	if (sbSelfChange) {					// 自分で動かした分は無視
		sbSelfChange = false;
		return;
	}
	if (!samples)  return;
	const total = sbin.offsetWidth || 1;
	viewStart = sb.scrollLeft / total * duration;
	clampView();
	draw();
});

/* ---------- 描画 ---------- */
function layout(){
	const dpr = window.devicePixelRatio || 1;
	cv.width  = Math.round(cv.clientWidth * dpr);
	cv.height = Math.round(cv.clientHeight * dpr);
	ctx.setTransform(dpr,0,0,dpr,0,0);
	syncScrollbar();
	draw();
}
window.addEventListener('resize', () => { clampView(); layout(); });

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function draw(){
	const w = cv.clientWidth
	const h = cv.clientHeight;
	const mid = RUL + (h - RUL)/2;
	const amp = (h - RUL)/2 - 6;
	ctx.clearRect(0,0,w,h);
	ctx.fillStyle = css('--panel'); ctx.fillRect(0,0,w,h);
	if (!samples) {
		ctx.fillStyle = css('--muted');
		ctx.font = '13px ' + css('--sans');
		ctx.textAlign = 'center';
		ctx.fillText('「ファイル」ボタンを押し、ファイルを選択してください', w/2, h/2);
		ctx.textAlign = 'left';
		return;
	}

	drawRuler(w, RUL);

	// 中心線
	ctx.strokeStyle = css('--axis');
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, mid+0.5);
	ctx.lineTo(w, mid+0.5);
	ctx.stroke();

	// 波形（samplesはInt16スケールなので、描画時に /PK_SCALE して振幅[-1..1]へ戻す）
	const spp = viewDur * SR / w;
	const s0 = viewStart * SR;
	ctx.strokeStyle = css('--wave');
	ctx.lineWidth = 1;
	ctx.beginPath();
	if (spp < 1.2) {
		const a = Math.max(0, Math.floor(s0) - 1);
		const b = Math.min(samples.length, Math.ceil(s0 + viewDur*SR) + 1);
		for (let i = a; i < b; i++) {
			const x = (i - s0) / spp;
			const y = mid - (samples[i] / PK_SCALE) * amp;
			i===a ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
		}
	} else {
		let lvl = null;
		for (const L of levels) {
			if (L.step <= spp) {
				lvl = L;
			} else {
				break;
			}
		}
		for (let x = 0; x < w; x++) {
			const a = s0 + x * spp;
			const b = a + spp;
			let lo = 1e9;
			let hi = -1e9;
			if (lvl) {
				const i0 = Math.max(0, Math.floor(a / lvl.step));
				const i1 = Math.min(lvl.mn.length, Math.max(i0 + 1, Math.ceil(b / lvl.step)));
				for (let i = i0; i < i1; i++) {
					if (lvl.mn[i] < lo)  lo=lvl.mn[i];
					if (lvl.mx[i] > hi)  hi=lvl.mx[i];
				}
				if (lo <= hi) {
					lo /= PK_SCALE;
					hi /= PK_SCALE;
				}
			} else {
				const i0 = Math.max(0, Math.floor(a));
				const i1 = Math.min(samples.length, Math.max(i0 + 1, Math.ceil(b)));
				for (let i = i0; i < i1; i++) {
					const v = samples[i] / PK_SCALE;
					if (v < lo)  lo=v;
					if (v > hi)  hi=v;
				}
			}
			if (lo > hi)  continue;
			ctx.moveTo(x + 0.5, mid - hi * amp);
			ctx.lineTo(x + 0.5, mid - lo * amp - 0.6);
		}
	}
	ctx.stroke();

	// 選択中の区間を淡く塗る
	if (sel < handles.length-1) {
		const x1 = t2x(handles[sel].t);
		const x2 = t2x(handles[sel + 1].t);
		ctx.fillStyle = css('--hot') + '1f';
		ctx.fillRect(x1, RUL, x2 - x1, h - RUL);
	}

	// ハンドル
	for (let i = 0; i < handles.length; i++) {
		const x = t2x(handles[i].t);
		if (x < -12 || x > w+12)  continue;
		const on = i === sel;
		ctx.strokeStyle = on ? css('--hot') : css('--cold');
		ctx.lineWidth = on ? 2 : 1.5;
		ctx.beginPath();
		ctx.moveTo(x, RUL);
		ctx.lineTo(x, h);
		ctx.stroke();
		ctx.fillStyle = ctx.strokeStyle;
		const fixed = (i === 0 || i === handles.length - 1);
		if (fixed) {
			ctx.fillRect(x - 4, RUL, 8, 8);
		} else {
			ctx.beginPath();
			ctx.arc(x, RUL + 5, 5, 0, 6.2832);
			ctx.fill();
		}
		// このハンドルから始まる区間の番号を、ハンドル上部の右横に表示
		if (i < handles.length-1) {
			ctx.font = '500 10px ' + css('--mono');
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			ctx.fillText(String(i + 1), x + 7, RUL + 5);
		}
	}
	ctx.textBaseline = 'alphabetic';

	// 再生位置
	if (playing) {
		const t = playFrom + (audioCtx.currentTime - playAt);
		if (t <= playTo) {
			const x = t2x(t);
			ctx.strokeStyle = css('--play');
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x, RUL);
			ctx.lineTo(x, h);
			ctx.stroke();
		}
	}
}

function drawRuler(w, RUL){
	ctx.fillStyle = css('--panel2');
	ctx.fillRect(0, 0, w, RUL);
	ctx.strokeStyle = css('--axis');
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, RUL + 0.5);
	ctx.lineTo(w, RUL + 0.5);
	ctx.stroke();
	const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
	let st = steps[steps.length - 1];
	for (const s of steps) {
		if (viewDur / s <= 12) {
			st = s;
			break;
		}
	}
	ctx.fillStyle = css('--muted');
	ctx.font = '10px ' + css('--mono');
	const first = Math.ceil(viewStart / st) * st;
	for (let t = first; t <= viewStart + viewDur + 1e-9; t += st) {
		const x = Math.round(t2x(t)) + 0.5;
		ctx.strokeStyle = css('--axis');
		ctx.beginPath();
		ctx.moveTo(x, RUL - 5);
		ctx.lineTo(x, RUL);
		ctx.stroke();
		ctx.fillText(fmt(t, st < 1), x + 3, 12);
	}
}

function fmt(t, ms = true) {
	if (!isFinite(t))  return '–';
	const m = Math.floor(t/60)
	const s = t - m * 60;
	return m + ':' + (s < 10 ? '0' : '') + (ms ? s.toFixed(3) : s.toFixed(1));
}

/* ---------- ポインタ操作 ---------- */
const HIT = 12;
const pts = new Map();
let mode = null;					// 'handle' | 'pan' | 'pinch'
let dragIdx = -1;
let moved = false;
let downX = 0;
let downY = 0;
let lpTimer = null;
let pinch = null;

function localX(e) {
	return e.clientX - cv.getBoundingClientRect().left;
}

function localY(e) {
	return e.clientY - cv.getBoundingClientRect().top;
}

function hitHandle(x) {
	let best = -1;
	let bd = HIT;
	for (let i = 0; i < handles.length; i++) {
		const d = Math.abs(t2x(handles[i].t) - x);
		if (d <= bd) {
			bd = d;
			best = i;
		}
	}
	return best;
}

cv.addEventListener('pointerdown', e => {
	if (!samples)  return;
	cv.setPointerCapture(e.pointerId);
	pts.set(e.pointerId, {x: e.clientX, y: e.clientY});

	if (pts.size === 2) {
		clearTimeout(lpTimer);
		mode = 'pinch';
		const p = [...pts.values()];
		const cx = (p[0].x + p[1].x) / 2 - cv.getBoundingClientRect().left;
		pinch = { d: Math.hypot(p[0].x-p[1].x, p[0].y - p[1].y) || 1, dur: viewDur, at: x2t(cx) };
		return;
	}
	if (pts.size > 2)  return;

	const x = localX(e);
	const y = localY(e);
	downX = e.clientX;
	downY = e.clientY;
	moved = false;
	const hi = hitHandle(x);
	if (hi >= 0) {
		mode = 'handle';
		dragIdx = hi;
		sel = (handles.length === 2) ? 0 : hi;
		draw();
		renderList();
		const fixed = (hi === 0 || hi === handles.length - 1);
		const onMarker = Math.abs(y - (RUL + 5)) <= HIT; // 上部の丸/四角マーカーの近くだけ
		if (!fixed && onMarker) {
			lpTimer = setTimeout(() => {
				removeHandle(dragIdx);
				mode = null;
				dragIdx = -1;
			}, 1000);
		}
	} else {
		mode = 'pan';
		pinch = { start: viewStart, x0: e.clientX };
	}
});

cv.addEventListener('pointermove', e => {
	if (!samples || !pts.has(e.pointerId))  return;
	pts.set(e.pointerId, {x: e.clientX, y: e.clientY});

	if (mode === 'pinch' && pts.size === 2) {
		const p = [...pts.values()];
		const rect = cv.getBoundingClientRect();
		const cx = (p[0].x + p[1].x) / 2 - rect.left;
		const d = Math.hypot(p[0].x-p[1].x, p[0].y - p[1].y) || 1;
		viewDur = Math.min(duration, Math.max(MINDUR, pinch.dur * (pinch.d / d)));
		viewStart = pinch.at - (cx / cv.clientWidth) * viewDur;
		clampView();
		syncScrollbar();
		draw();
		return;
	}

	if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) {
		if (!moved) {
			moved = true;
			clearTimeout(lpTimer);
		}
	}

	if (mode === 'handle' && dragIdx >= 0 && moved) {
		const fixed = (dragIdx===0 || dragIdx===handles.length-1);
		if (fixed)  return;
		const lo = handles[dragIdx - 1].t + 1/SR;
		const hi = handles[dragIdx + 1].t - 1/SR;
		handles[dragIdx].t = Math.min(hi, Math.max(lo, x2t(localX(e))));
		draw();
		renderList();
	} else if (mode === 'pan' && moved) {
		viewStart = pinch.start - (e.clientX - pinch.x0) / cv.clientWidth * viewDur;
		clampView();
		syncScrollbar();
		draw();
	}
});

function endPointer(e) {
	clearTimeout(lpTimer);
	pts.delete(e.pointerId);
	if (mode === 'pan' && !moved && samples)  addHandle(x2t(localX(e)));
	if (pts.size === 0) {
		mode = null;
		dragIdx = -1;
	} else if (pts.size === 1 && mode === 'pinch') {
		const p = [...pts.entries()][0];
		mode = 'pan';
		moved = true;
		pinch = { start: viewStart, x0: p[1].x };
		downX = p[1].x;
		downY = p[1].y;
	}
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);

cv.addEventListener('wheel', e => {
	if (!samples)  return;
	e.preventDefault();
	if (e.shiftKey) {
		viewStart += e.deltaY / cv.clientWidth * viewDur;
		clampView();
		syncScrollbar();
		draw();
	} else {
		zoomAt(Math.exp(e.deltaY * 0.0015), localX(e));
	}
}, {passive: false});

/* ---------- ハンドル操作 ---------- */
function addHandle(t) {
	t = Math.min(duration, Math.max(0, t));
	if (handles.some(h => Math.abs(h.t - t) < viewDur/cv.clientWidth * 3))  return;
	handles.push({t, id: uid++});
	handles.sort((a,b) => a.t - b.t);
	sel = handles.findIndex(h => h.t === t);
	draw();
	renderList();
}
function removeHandle(i) {
	if (i <= 0 || i >= handles.length-1)  return;
	handles.splice(i,1);
	sel = Math.min(i, handles.length - 1);		// 直後のハンドルが赤になる
	if (handles.length === 2) sel = 0;				// 先頭・末尾だけなら先頭を再生開始点に
	draw();
	renderList();
}

// 一覧クリック時: 区間の開始点を中央に。区間が表示幅より広い場合は
// 開始点を左端に固定し、区間が末尾側で画面境界に達する場合は右端に固定する。
function jumpToRegionStart(i) {
	const start = handles[i].t;
	const end = handles[i+1].t;
	let want = start - viewDur / 2;
	if (end - start > viewDur) {
		want = Math.max(start, Math.min(end - viewDur, want));
	}
	viewStart = want;
	clampView();
	syncScrollbar();
	draw();
}

/* ---------- 再生 ---------- */
function ac() {
	if (!audioCtx)  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	if (audioCtx.state === 'suspended')  audioCtx.resume();
	return audioCtx;
}

// Int16で保持しているサンプルから、指定範囲[a,b)だけをFloat32のAudioBufferに
// 変換して返す。ファイル全体をFloat32で持たない代わりに、実際に再生する
// 区間ぶんだけその場で作る（区間は通常短いのでコストは無視できる）。
function makeRegionBuffer(c, a, b) {
	const n = Math.max(1, b - a);
	const buf = c.createBuffer(1, n, SR);
	const ch = buf.getChannelData(0);
	for (let k = 0; k < n; k++) {
		ch[k] = samples[a + k] / PK_SCALE;
	}
	return buf;
}

function playRegion(i){
	if (!samples || i >= handles.length-1)  return;
	stop();
	const c = ac();
	const from = handles[i].t;
	const to = handles[i + 1].t;
	if (to - from < 0.001)  return;
	const a = Math.max(0, Math.round(from * SR));
	const b = Math.min(samples.length, Math.round(to * SR));
	src = c.createBufferSource();
	src.buffer = makeRegionBuffer(c, a, b);
	src.connect(c.destination);
	src.onended = () => {
		if (playing)  stop();
	};
	// 再生開始の瞬間だけ、開始点・終了点の可視状態を見て一度だけ判定する。
	// 両方すでに見えているならスクロール不要（カーソルのみ動く）。
	// 開始点だけ見えているならその位置を、どちらも見えていなければ中央を基準にし、
	// 以後は再生が終わるかファイル末尾に達するまでスクロールを続ける
	// （区間の終了点が画面に入ってきても、そこでは止めない）。
	const startVisible0 = from >= viewStart - EPS && from <= viewStart + viewDur + EPS;
	const endVisible0   = to   >= viewStart - EPS && to   <= viewStart + viewDur + EPS;
	scrollingActive = !(startVisible0 && endVisible0);
	followAnchor = startVisible0 ? Math.min(1, Math.max(0, t2x(from) / cv.clientWidth)) : 0.5;
	playFrom = from;
	playTo = to;
	playAt = c.currentTime;
	$('playStop').textContent = '停止';
	playing = true;
	src.start(0); // 既に区間ぶんだけのバッファなので、頭から鳴らすだけでよい
	tick();
}
function tick() {
	if (!playing)  return;
	follow();
	draw();
	requestAnimationFrame(tick);
}
// 再生位置を追従させる。スクロールするかどうか・アンカー位置は再生開始時に一度だけ
// playRegion() で決めてあり、ここでは毎フレーム再判定しない（区間の終了点が画面に
// 入ってきても止めない）。スクロールはファイル自体の終端（clampView）に達したところで
// 頭打ちになり、それ以降はカーソルだけが動く。
const EPS = 1e-9;
function follow() {
	if (!scrollingActive)  return;
	const t = Math.min(playTo, playFrom + (audioCtx.currentTime - playAt));
	const want = t - followAnchor * viewDur;
	if (Math.abs(want - viewStart) < 1e-6)  return;
	viewStart = want;
	clampView();
	syncScrollbar();
}
function stop() {
	if (src) {
		try {
			src.onended = null;
			src.stop();
		} catch(_) {}
		src = null;
	}
	$('playStop').textContent = '再生';
	playing = false;
	draw();
}
$('playStop').onclick = () => {
	if (playing) {
		stop();
	} else {
		playRegion(sel);
	}
}

/* ---------- 区間リスト ---------- */
function renderList() {
	const box = $('list');
	if (handles.length < 2) {
		box.innerHTML = '<p class="empty">ハンドルを追加すると、その間が区間として並びます。</p>';
		return;
	}
	let html = '<table><thead><tr><th>#</th><th>開始</th><th>終了</th><th>長さ</th><th></th></tr></thead><tbody>';
	for (let i = 0; i < handles.length - 1; i++) {
		const a = handles[i].t;
		const b = handles[i + 1].t;
		html += `<tr class="${i===sel?'cur':''}" data-i="${i}"><td>${String(i+1).padStart(2,'0')}</td><td>${fmt(a)}</td><td>${fmt(b)}</td><td>${(b-a).toFixed(3)} s</td><td><button data-analyze="${i}">分析</button></td></tr>`;
	}
	box.innerHTML = html + '</tbody></table>';
	box.querySelectorAll('tr[data-i]').forEach(tr => {
		tr.addEventListener('click', ev => {
			const a = ev.target.getAttribute('data-analyze');
			const i = +tr.dataset.i;
			sel = i;
			if (a !== null) {
				renderList();
				if (checkLengthLimit(+a) === -1)  return;
				openAnalysisDialog(+a);
			} else {
				// 行そのものをクリック: 開始点を確認できるようにビューを合わせる
				jumpToRegionStart(i);
				renderList();
			}
		});
	});
}

function checkLengthLimit(i) {
	const MAXSEC = 30;
	if (handles[i + 1].t - handles[i].t >= MAXSEC) {
		alert(`分析対象は${MAXSEC}秒までにしてください。`);
		return -1;
	} else {
		return 0;
	}
}

/* ---------- 区間の分析（Intonation Coach/T をダイアログで起動） ---------- */
// 実際のデプロイ環境に合わせてパスを調整してください。
const IC_URL = './intonationCoachS/intonationCoachE.html?embedded=1';
const icDialog = $('icDialog');
const icFrame = $('icFrame');
const icLoading = $('icLoading');
let icFrameLoaded = false;
let icReady = false;
let icPendingSegment = null;
let icInitFailed = false;			// iframe側のモデル初期化が失敗したことが分かっている場合 true
let icReadyTimeoutId = null;		// ic-ready を待つタイムアウト（無反応のまま固まるのを防ぐ）
const IC_READY_TIMEOUT_MS = 20000;

// Int16スケールの区間データを、Intonation Coach/T側の想定(Float32 PCM)に
// 変換してから渡す。区間は最大30秒（checkLengthLimit）なので変換コストは小さい。
function sliceSegmentSamples(i) {
	const a = Math.max(0, Math.round(handles[i].t * SR));
	const b = Math.min(samples.length, Math.round(handles[i + 1].t * SR));
	const n = Math.max(0, b - a);
	const f32 = new Float32Array(n);
	for (let k = 0; k < n; k++) {
		f32[k] = samples[a + k] / PK_SCALE;
	}
	return f32;
}

function showIcMessage(text) {
	icLoading.style.display = '';
	icLoading.textContent = text;
}

function armIcReadyTimeout() {
	clearTimeout(icReadyTimeoutId);
	icReadyTimeoutId = setTimeout(() => {
		if (!icReady && !icInitFailed) {
			showIcMessage('分析モジュールの準備に時間がかかっています。回線状況を確認するか、しばらくしてからもう一度お試しください。');
		}
	}, IC_READY_TIMEOUT_MS);
}

function openAnalysisDialog(i) {
	if (!samples || i < 0 || i >= handles.length - 1) return;
	$('icDialogTitle').textContent = `区間 ${String(i+1).padStart(2,'0')} を分析`;
	const segment = sliceSegmentSamples(i);

	if (!icFrameLoaded) {
		icFrame.addEventListener('load', () => {
			icFrameLoaded = true;
			icLoading.textContent = '分析モジュールのロード中です…';
		}, { once: true });
		icFrame.src = IC_URL;
		icFrame.hidden = false;
	}

	if (icInitFailed) {
		// 初期化が失敗したことが既に分かっている場合、無駄に待たせずすぐ知らせる
		showIcMessage('分析モジュールの初期化に失敗しました。ページを再読み込みしてからもう一度お試しください。');
		icDialog.showModal();
		return;
	}

	if (icReady) {
		postSegmentToFrame(segment);
	} else {
		icPendingSegment = segment; // ic-ready が来たら送る
		armIcReadyTimeout();
	}
	icDialog.showModal();
}

function postSegmentToFrame(segment) {
	// segment は Float32Array（sliceSegmentSamples()で変換済み）
	icLoading.style.display = 'none';
	const buf = segment.buffer.slice(segment.byteOffset, segment.byteOffset + segment.byteLength);
	icFrame.contentWindow.postMessage({ type: 'analyze-segment', sampleRate: SR, samples: buf }, '*', [buf]);
}

window.addEventListener('message', (e) => {
	const data = e.data;
	if (!data || e.source !== icFrame.contentWindow)  return;

	if (data.type === 'ic-init-error') {
		// 'ic-ready' が永遠に届かず待ち続けてしまうのを防ぐ。以後の分析要求にも即座に知らせる。
		icInitFailed = true;
		clearTimeout(icReadyTimeoutId);
		showIcMessage('分析モジュールの初期化に失敗しました。ページを再読み込みしてからもう一度お試しください。');
		return;
	}

	if (data.type !== 'ic-ready')  return;
	clearTimeout(icReadyTimeoutId);
	icReady = true;
	if (icPendingSegment) {
		const seg = icPendingSegment;
		icPendingSegment = null;
		postSegmentToFrame(seg);
	} else {
		icLoading.style.display = 'none';
	}
});

$('icDialogClose').onclick = () => icDialog.close();
icDialog.addEventListener('cancel', () => {}); // Escで閉じるのはそのまま許可
icDialog.addEventListener('close', () => {
	// close/cancel いずれでも 'close' イベントは発火するので、ここ一箇所で
	// iframe側へ「一時停止して」と伝える（再生停止・再生用URLの解放）。
	icFrame.contentWindow?.postMessage({ type: 'ic-suspend' }, '*');
});

layout();
