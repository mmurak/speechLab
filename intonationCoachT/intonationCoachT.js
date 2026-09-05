import { SwiftF0model } from '../SwiftF0model/SwiftF0model.js';
import { LiteralsManager } from './LiteralsManager.js';

const paramObj = Object.fromEntries(new URLSearchParams(window.location.search));
const LANGUAGE = ('lang' in paramObj) ? paramObj.lang : 'jpn';

const LITERALS = new LiteralsManager(LANGUAGE);
LITERALS.setDOM();
document.getElementById('recordBtn').title = LITERALS.get('recordBtnHint');

// ---------------------------------------------------------------------
// SwiftF0の参照実装（Python）より
// ---------------------------------------------------------------------
const TARGET_SR = 16000;			// SwiftF0は16kHzのサンプリング周波数を要求している。
const HOP_LENGTH = 256;			// STFTのスライドサイズ（256/16000Hz=16m秒）
const FRAME_LENGTH = 1024;		// STFTのウィンドウサイズ（1024/16000Hz=64m秒）
const CENTER_OFFSET = (FRAME_LENGTH - 1) / 2 - (FRAME_LENGTH - HOP_LENGTH) / 2;
const MIN_AUDIO_LENGTH = 256;
const MIN_RECORD_SEC = 0.05;		// 録音の最小長（これ未満は分析しない）
const pitchFMin = 50;				// ピッチチャートの描画周波数下限
const pitchFMax = 800;				// ピッチチャートの描画周波数上限

const DEFAULT_CONF = 0.90;			// 信頼度のデフォルト値
const PIXELS_PER_SECOND = 140;		// ピッチチャートの横スクロール解像度（詰め込み表示にしない）
const PLOT_ORIGIN_X = 40;			// 左側の周波数目盛りぶんの余白(px)
const WINDOW_BUFFER_SEC = 0.5;		// 可視範囲の前後に余分に描画しておく秒数（端でのポップインを防ぐ）

// SwiftF0 ORT周りの変数
let session = null;

// --- ファイル分析・再生周りの状態変数 ---
let fileObjectURL = null;			// 再生用（Audio要素のsrc）
let fileAnalysisData = null;		// {pitchData, confData, duration}

// --- マイク録音・再生周りの状態変数 ---
let micStream = null;
let micAudioCtx = null;
let micWorkletNode = null;
let micSourceNode = null;
let micNativeRate = 0;
let isRecording = false;
let micChunks = [];					// 録音時に使用するネイティブレートのFloat32Arrayチャンク
const RECORDING_WARMUP_SEC = 0.15;	// マイク起動直後の"プチッ"というポップノイズを避けるため、この秒数ぶんを捨てる
let warmupSamplesToSkip = 0;			// 録音開始時にRECORDING_WARMUP_SEC分のサンプル数へ設定する
let micObjectURL = null;			// 再生用（Audio要素のsrc）
let micAnalysisData = null;			// {pitchData, confData, duration}

// マイク録音表示の位置をドラッグするための管理変数
let micTimeOffset = 0;				// 表示上のみのオフセット(秒)。分析データ自体は変更しない
let isDraggingMicOffset = false;
let micOffsetDragStartX = 0;
let micOffsetDragStartValue = 0;

// ユーザーインタフェース周りのDOM
class UserInterfaceWidgets {
	constructor() {
		this.fileInput = document.getElementById('audioFile');
		this.playPauseBtn = document.getElementById('playPauseBtn');
		this.fileSpeedSlider = document.getElementById('fileSpeedSlider');
		this.fileSpeedValue = document.getElementById('fileSpeedValue');
		this.pitchScrollContainer = document.getElementById('pitchChartScrollContainer');
		this.scrollbarTrack = document.getElementById('pitchScrollbarTrack');
		this.scrollbarThumb = document.getElementById('pitchScrollbarThumb');
		this.pitchScrollSpacer = document.getElementById('pitchScrollSpacer');
		this.pitchPlotWrapper = document.getElementById('pitchPlotWrapper');
		this.pitchCanvas = document.getElementById('pitchCanvas');
		this.statusDiv = document.getElementById('status');
		this.recordBtn = document.getElementById('recordBtn');
		this.micPlayPauseBtn = document.getElementById('micPlayPauseBtn');
		this.micSpeedSlider = document.getElementById('micSpeedSlider');
		this.micSpeedValue = document.getElementById('micSpeedValue');

		this.confThresholdInput = document.getElementById('confThreshold');
		this.confValueSpan = document.getElementById('confValue');
		this.confLabel = document.getElementById('confLabel');
		this.confThresholdMicInput = document.getElementById('confThresholdMic');
		this.confValueMicSpan = document.getElementById('confValueMic');
		this.confLabelMic = document.getElementById('confLabelMic');
	}
}
const UI = new UserInterfaceWidgets();

// 再生用のAudio要素（ピッチを保ったまま速度可変で再生するために<audio>を使う）
// iOS/iPadOS等では、JSだけで生成した(DOMに存在しない)Audio要素だと再生が不安定になる
// ことがあるため、HTML側に用意した実在の<audio>要素を参照する。
const audioEl = document.getElementById('filePlayerElement');
const micAudioEl = document.getElementById('micPlayerElement');

// audioEl.currentTime はブラウザ内部の更新間隔が粗いことがあり（数百m秒おきにしか
// 値が変わらない場合がある）、そのままカーソル描画に使うと「遅れ・カクつき」に
// 見えることがある。実際に値が変化した瞬間とその時のperformance.now()を記録して
// おき、次に値が変わるまでの間は経過時間から現在位置を補間することで、見た目の
// 滑らかさを改善する（あくまで見た目の補間であり、音自体の遅延を無くすものではない）。
function createSmoothedClock(mediaEl) {
	let lastMediaTime = 0;
	let lastWallTime = 0;
	let hasTick = false;
	return function getSmoothedTime() {
		const raw = mediaEl.currentTime;
		const now = performance.now();
		if (!hasTick || raw !== lastMediaTime || mediaEl.paused) {
			lastMediaTime = raw;
			lastWallTime = now;
			hasTick = true;
			return raw;
		}
		// currentTimeの実更新が来るまでの「つなぎ」。ブレが大きくなりすぎないよう上限を設ける。
		const elapsedSec = Math.min((now - lastWallTime) / 1000, 0.35);
		return lastMediaTime + elapsedSec * mediaEl.playbackRate;
	};
}
const getFileTime = createSmoothedClock(audioEl);
const getMicTime = createSmoothedClock(micAudioEl);

// 描画用コンテキスト
const pitchCtx = UI.pitchCanvas.getContext('2d');

/* ********************************************************************************
 * ピッチチャートのレイアウト・仮想スクロール
 * ---------------------------------------------------------------------------
 * 長い音声でも重くならないよう、キャンバス自体は常に「表示領域と同じ小さな
 * 固定サイズ」のままにし、音声全体ぶんの横スクロールは透明なスペーサー要素
 * (#pitchScrollSpacer)に受け持たせる。キャンバスを乗せた#pitchPlotWrapperは
 * スクロール位置ぶんだけCSSのtransformで逆方向にずらし、常に表示領域の左上に
 * 重なって見えるようにする（仮想スクロール）。
 * 描画時も、現在の可視時間範囲に該当するデータだけをインデックス計算で絞り
 * 込んでから描くため、音声がどれだけ長くても毎回の描画コストはほぼ一定になる。
 * ********************************************************************************/
function computeTotalDuration() {
	const fileDur = fileAnalysisData ? fileAnalysisData.duration : 0;
	const micEnd = micAnalysisData ? (micTimeOffset + micAnalysisData.duration) : 0;
	return Math.max(fileDur, micEnd, 1.0);
}

function timeToX(t) {
	return PLOT_ORIGIN_X + t * PIXELS_PER_SECOND;
}

// キャンバス（表示領域と同じ小さいサイズ）とスペーサー（音声全体ぶんの幅）を
// 必要に応じて再設定し、現在のスクロール位置に合わせて再描画する。
function layoutAndRender() {
	const containerHeight = UI.pitchScrollContainer.clientHeight || 280;
	const containerWidth = UI.pitchScrollContainer.clientWidth || 300;
	const totalDuration = computeTotalDuration();
	const spacerWidth = Math.max(containerWidth, PLOT_ORIGIN_X + totalDuration * PIXELS_PER_SECOND);
	const dpr = window.devicePixelRatio || 1;

	UI.pitchScrollSpacer.style.width = spacerWidth + 'px';

	UI.pitchPlotWrapper.style.width = containerWidth + 'px';
	UI.pitchPlotWrapper.style.height = containerHeight + 'px';

	UI.pitchCanvas.style.width = containerWidth + 'px';
	UI.pitchCanvas.style.height = containerHeight + 'px';
	UI.pitchCanvas.width = Math.round(containerWidth * dpr);
	UI.pitchCanvas.height = Math.round(containerHeight * dpr);
	pitchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

	syncWrapperTransform();
	render();
	updateScrollbarThumb();
}
layoutAndRender();

let resizeTimeoutId = null;
function scheduleResize() {
	clearTimeout(resizeTimeoutId);
	resizeTimeoutId = setTimeout(layoutAndRender, 100);
}
const resizeObserver = new ResizeObserver(scheduleResize);
resizeObserver.observe(UI.pitchScrollContainer);

// プロット用ラッパーを、現在のスクロール位置ぶんだけ逆方向にずらして、常に
// 表示領域の左上に重なって見えるようにする（＝キャンバスは仮想的に「固定」）。
function syncWrapperTransform() {
	UI.pitchPlotWrapper.style.transform = 'translateX(' + UI.pitchScrollContainer.scrollLeft + 'px)';
}

// スクロール位置を指定し、対応する見た目の追従・再描画まで行う。
function setScrollLeftAndRender(target) {
	const container = UI.pitchScrollContainer;
	const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
	container.scrollLeft = Math.max(0, Math.min(maxScrollLeft, target));
	syncWrapperTransform();
	render();
	updateScrollbarThumb();
}

// ユーザーが手動でスクロールバーをドラッグ／スワイプした場合の追従・再描画。
UI.pitchScrollContainer.addEventListener('scroll', () => {
	syncWrapperTransform();
	render();
	updateScrollbarThumb();
});

/* ********************************************************************************
 * 自前の太いスクロールバー（トラック＋つまみ）
 * ---------------------------------------------------------------------------
 * Android等のタッチ環境では、ネイティブの横スクロールバーが細いオーバーレイに
 * なりCSSで太くしても効かないことが多い。また、マイク波形のドラッグ操作の
 * ためキャンバス上のタッチスクロールも無効化している。そこで、掴みやすい
 * 太さのスクロールバーをHTML要素として自前で用意し、ポインター操作で直接
 * コンテナのscrollLeftを操作する。
 * ********************************************************************************/
function updateScrollbarThumb() {
	const container = UI.pitchScrollContainer;
	const trackWidth = UI.scrollbarTrack.clientWidth;
	if (trackWidth <= 0) return;

	const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
	const visibleRatio = container.scrollWidth > 0 ? Math.min(1, container.clientWidth / container.scrollWidth) : 1;
	const thumbWidth = Math.max(44, visibleRatio * trackWidth);
	const availableTrack = Math.max(1, trackWidth - thumbWidth);
	const scrollRatio = maxScrollLeft > 0 ? (container.scrollLeft / maxScrollLeft) : 0;
	const thumbLeft = scrollRatio * availableTrack;

	UI.scrollbarThumb.style.width = thumbWidth + 'px';
	UI.scrollbarThumb.style.transform = 'translateX(' + thumbLeft + 'px)';
}

let isDraggingScrollbar = false;
let scrollbarDragStartClientX = 0;
let scrollbarDragStartScrollLeft = 0;

UI.scrollbarThumb.addEventListener('pointerdown', (e) => {
	isDraggingScrollbar = true;
	scrollbarDragStartClientX = e.clientX;
	scrollbarDragStartScrollLeft = UI.pitchScrollContainer.scrollLeft;
	UI.scrollbarThumb.classList.add('dragging');
	try { UI.scrollbarThumb.setPointerCapture(e.pointerId); } catch (err) {}
});
UI.scrollbarThumb.addEventListener('pointermove', (e) => {
	if (!isDraggingScrollbar) return;
	const container = UI.pitchScrollContainer;
	const trackWidth = UI.scrollbarTrack.clientWidth;
	const thumbWidth = UI.scrollbarThumb.clientWidth;
	const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
	const availableTrack = Math.max(1, trackWidth - thumbWidth);
	const deltaPx = e.clientX - scrollbarDragStartClientX;
	const deltaScroll = (deltaPx / availableTrack) * maxScrollLeft;
	setScrollLeftAndRender(scrollbarDragStartScrollLeft + deltaScroll);
});
function endScrollbarDrag() {
	if (!isDraggingScrollbar) return;
	isDraggingScrollbar = false;
	UI.scrollbarThumb.classList.remove('dragging');
}
UI.scrollbarThumb.addEventListener('pointerup', endScrollbarDrag);
UI.scrollbarThumb.addEventListener('pointercancel', endScrollbarDrag);

// トラックの、つまみ以外の部分をタップ／クリックした場合は、その位置へ直接ジャンプする。
UI.scrollbarTrack.addEventListener('pointerdown', (e) => {
	if (e.target === UI.scrollbarThumb) return; // つまみ自体は上のハンドラに任せる
	const container = UI.pitchScrollContainer;
	const rect = UI.scrollbarTrack.getBoundingClientRect();
	const trackWidth = rect.width;
	const thumbWidth = UI.scrollbarThumb.clientWidth;
	const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
	const availableTrack = Math.max(1, trackWidth - thumbWidth);
	const clickX = e.clientX - rect.left - thumbWidth / 2;
	const targetRatio = Math.min(1, Math.max(0, clickX / availableTrack));
	setScrollLeftAndRender(targetRatio * maxScrollLeft);
});

/* ********************************************************************************
 * confidence UI関連
 * ********************************************************************************/
UI.confThresholdInput.addEventListener('input', (e) => {
	const val = parseFloat(e.target.value);
	UI.confValueSpan.textContent = val.toFixed(2);
	render();
});
UI.confLabel.addEventListener('click', () => {
	UI.confThresholdInput.value = DEFAULT_CONF;
	UI.confValueSpan.textContent = DEFAULT_CONF.toFixed(2);
	render();
});
UI.confLabel.title = LITERALS.get('confTips');

UI.confThresholdMicInput.addEventListener('input', (e) => {
	const val = parseFloat(e.target.value);
	UI.confValueMicSpan.textContent = val.toFixed(2);
	render();
});
UI.confLabelMic.addEventListener('click', () => {
	UI.confThresholdMicInput.value = DEFAULT_CONF;
	UI.confValueMicSpan.textContent = DEFAULT_CONF.toFixed(2);
	render();
});
UI.confLabelMic.title = LITERALS.get('confTips');
UI.confValueSpan.textContent = DEFAULT_CONF.toFixed(2);
UI.confValueMicSpan.textContent = DEFAULT_CONF.toFixed(2);

/* ********************************************************************************
 * 再生速度 UI関連（ピッチを変えずに速度のみ変更する）
 * ********************************************************************************/
UI.fileSpeedSlider.addEventListener('input', (e) => {
	const rate = parseFloat(e.target.value);
	audioEl.playbackRate = rate;
	UI.fileSpeedValue.textContent = rate.toFixed(2) + 'x';
});
UI.micSpeedSlider.addEventListener('input', (e) => {
	const rate = parseFloat(e.target.value);
	micAudioEl.playbackRate = rate;
	UI.micSpeedValue.textContent = rate.toFixed(2) + 'x';
});

function applyPreservesPitch(el) {
	// ブラウザ間の実装差異を吸収するため、対応するプロパティ全てに設定する。
	el.preservesPitch = true;
	el.mozPreservesPitch = true;
	el.webkitPreservesPitch = true;
}
applyPreservesPitch(audioEl);
applyPreservesPitch(micAudioEl);

/* ********************************************************************************
 * SwiftF0モデルの初期化
 * ********************************************************************************/
async function initModel() {
	try {
		ort.env.wasm.numThreads = 1; // avoid needing cross-origin isolation for SharedArrayBuffer
		ort.env.wasm.simd = true;
		const modelBytes = SwiftF0model();
		session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
		UI.statusDiv.textContent = LITERALS.get('statusReady');
		UI.recordBtn.disabled = false;
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('statusInitError');
	}
}
initModel();

/* ********************************************************************************
 * ファイル入力 → 全体分析
 * ********************************************************************************/
UI.fileInput.addEventListener('change', async (e) => {
	const file = e.target.files[0];
	if (!file) return;

	// 再生停止・状態リセット
	stopFilePlayback();
	clearMicComparison();
	fileAnalysisData = null;
	UI.playPauseBtn.disabled = true;
	UI.fileSpeedSlider.disabled = true;

	// 再生用URLの更新（Audio要素はデコード済みバッファを保持しないため軽量）
	if (fileObjectURL) URL.revokeObjectURL(fileObjectURL);
	fileObjectURL = URL.createObjectURL(file);
	audioEl.src = fileObjectURL;
	audioEl.playbackRate = parseFloat(UI.fileSpeedSlider.value);

	UI.statusDiv.textContent = LITERALS.get('statusDecoding');

	let decodeCtx = null;
	let decoded = null;
	try {
		decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
		const arrayBuffer = await file.arrayBuffer();
		decoded = await decodeCtx.decodeAudioData(arrayBuffer);
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('decodeError');
		if (decodeCtx) decodeCtx.close();
		return;
	}

	UI.statusDiv.textContent = LITERALS.get('statusAnalysingFile');
	await analyzeFullBuffer(decoded);
	// 分析専用に開いたコンテキストとデコード済みバッファはもう不要なので破棄する（メモリ軽量化）。
	decoded = null;
	decodeCtx.close();

	layoutAndRender();
	if (fileAnalysisData) {
		UI.playPauseBtn.disabled = false;
		UI.fileSpeedSlider.disabled = false;
		setScrollLeftAndRender(0); // 読み込み直後はチャートの先頭(左端)を表示する
	}
});

// AudioBufferを16kHzへダウンサンプルしてSwiftF0で分析する。
// 元のAudioBufferやダウンミックス配列は関数を抜けたら参照を残さず、GCに委ねる。
async function analyzeFullBuffer(buffer) {
	const nativeRate = buffer.sampleRate;
	const numChannels = buffer.numberOfChannels;
	const length = buffer.length;

	let mono;
	if (numChannels > 1) {
		mono = new Float32Array(length);
		for (let ch = 0; ch < numChannels; ch++) {
			const chData = buffer.getChannelData(ch);
			for (let i = 0; i < length; i++) {
				mono[i] += chData[i] / numChannels;
			}
		}
	} else {
		mono = buffer.getChannelData(0).slice(); // AudioBufferの内部参照から切り離すためコピーする
	}

	try {
		const outLen = Math.max(1, Math.ceil(mono.length * TARGET_SR / nativeRate));
		const offlineCtx = new OfflineAudioContext(1, outLen, TARGET_SR);
		const src = offlineCtx.createBufferSource();
		const buf = offlineCtx.createBuffer(1, mono.length, nativeRate);
		buf.copyToChannel(mono, 0);
		src.buffer = buf;
		src.connect(offlineCtx.destination);
		src.start(0);
		const rendered = await offlineCtx.startRendering();
		const audio16k = rendered.getChannelData(0);
		mono = null; // 用済みのため解放

		if (audio16k.length < MIN_AUDIO_LENGTH) {
			UI.statusDiv.textContent = LITERALS.get('fileAnalysisError');
			return;
		}

		const tensor = new ort.Tensor('float32', audio16k, [1, audio16k.length]);
		const out = await session.run({ input_audio: tensor });
		const pitchData = out.pitch_hz ? out.pitch_hz.data : Object.values(out)[0].data;
		const confData = out.confidence ? out.confidence.data : (out.f0_confidence ? out.f0_confidence.data : null);

		fileAnalysisData = {
			pitchData: pitchData,
			confData: confData,
			duration: audio16k.length / TARGET_SR
		};

		UI.statusDiv.textContent = `${LITERALS.get('statusFileReady')}${fileAnalysisData.duration.toFixed(2)}${LITERALS.get('sec')}${LITERALS.get('secClose')}`;
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('fileAnalysisError');
	}
}

/* ********************************************************************************
 * ピッチチャートの描画（現在の可視範囲だけを描く）
 * ********************************************************************************/

// 可視時間範囲に対応するpitchData配列のインデックス範囲を計算する。
// フレームiの時刻はiに比例するので、時刻からインデックスへ直接逆算でき、
// 全データを走査する必要がない（音声が長くてもコストが変わらない理由）。
function computeVisibleIndexRange(analysisData, timeShift, scrollLeft, canvasWidthCss) {
	const localTimeMin = (scrollLeft - PLOT_ORIGIN_X) / PIXELS_PER_SECOND - timeShift - WINDOW_BUFFER_SEC;
	const localTimeMax = (scrollLeft + canvasWidthCss - PLOT_ORIGIN_X) / PIXELS_PER_SECOND - timeShift + WINDOW_BUFFER_SEC;

	let iStart = Math.floor((localTimeMin * TARGET_SR - CENTER_OFFSET) / HOP_LENGTH) - 1;
	let iEnd = Math.ceil((localTimeMax * TARGET_SR - CENTER_OFFSET) / HOP_LENGTH) + 1;

	iStart = Math.max(0, iStart);
	iEnd = Math.min(analysisData.pitchData.length - 1, iEnd);
	return [iStart, iEnd];
}

function render() {
	const width = UI.pitchCanvas.clientWidth;
	const height = UI.pitchCanvas.clientHeight;
	const scrollLeft = UI.pitchScrollContainer.scrollLeft;

	pitchCtx.fillStyle = '#1e1e1e';
	pitchCtx.fillRect(0, 0, width, height);

	const fmin = pitchFMin, fmax = pitchFMax;
	const marks = [100, 200, 300, 400, 600, 800];
	pitchCtx.strokeStyle = '#333';
	pitchCtx.fillStyle = '#888';
	pitchCtx.font = '10px sans-serif';

	marks.forEach(hz => {
		const frac = (Math.log2(hz) - Math.log2(fmin)) / (Math.log2(fmax) - Math.log2(fmin));
		const y = height - (frac * (height - 30) + 15);
		pitchCtx.beginPath();
		pitchCtx.moveTo(PLOT_ORIGIN_X, y);
		pitchCtx.lineTo(width, y);
		pitchCtx.stroke();
		pitchCtx.fillText(hz + 'Hz', 5, y + 4);
	});

	function plotSeries(analysisData, color, minConf, timeShift) {
		if (!analysisData) return;
		const { pitchData, confData, duration } = analysisData;
		const [iStart, iEnd] = computeVisibleIndexRange(analysisData, timeShift, scrollLeft, width);
		pitchCtx.fillStyle = color;
		for (let i = iStart; i <= iEnd; i++) {
			const hz = pitchData[i];
			const conf = confData ? confData[i] : 1.0;
			if (conf < minConf || hz < fmin || hz > fmax) continue;

			const localTime = (i * HOP_LENGTH + CENTER_OFFSET) / TARGET_SR;
			if (localTime < 0 || localTime > duration) continue;

			const displayTime = localTime + timeShift;
			if (displayTime < 0) continue;

			const x = timeToX(displayTime) - scrollLeft; // 表示領域内でのローカル座標
			if (x < -4 || x > width + 4) continue; // 可視範囲外は描かない

			const frac = (Math.log2(hz) - Math.log2(fmin)) / (Math.log2(fmax) - Math.log2(fmin));
			const y = height - (frac * (height - 30) + 15);

			pitchCtx.beginPath();
			pitchCtx.arc(x, y, 2, 0, Math.PI * 2);
			pitchCtx.fill();
		}
	}

	plotSeries(fileAnalysisData, '#4af', parseFloat(UI.confThresholdInput.value), 0);						// ファイル分析: スカイブルー
	plotSeries(micAnalysisData, '#fa4', parseFloat(UI.confThresholdMicInput.value), micTimeOffset);	// マイク録音: オレンジ

	// ファイル再生カーソル（赤）
	if (fileAnalysisData && fileObjectURL) {
		const t = getFileTime();
		if (t >= 0 && t <= fileAnalysisData.duration) {
			const x = timeToX(t) - scrollLeft;
			if (x >= -2 && x <= width + 2) {
				pitchCtx.strokeStyle = audioEl.paused ? 'rgba(255,68,68,0.55)' : '#ff4444';
				pitchCtx.lineWidth = 2;
				pitchCtx.beginPath();
				pitchCtx.moveTo(x, 0);
				pitchCtx.lineTo(x, height);
				pitchCtx.stroke();
			}
		}
	}

	// マイク録音の再生カーソル（黄色）
	if (micAnalysisData && micObjectURL) {
		const t = getMicTime() + micTimeOffset;
		if (t >= 0 && t <= micAnalysisData.duration + micTimeOffset) {
			const x = timeToX(t) - scrollLeft;
			if (x >= -2 && x <= width + 2) {
				pitchCtx.strokeStyle = micAudioEl.paused ? 'rgba(255,210,74,0.55)' : '#ffd24a';
				pitchCtx.lineWidth = 2;
				pitchCtx.beginPath();
				pitchCtx.moveTo(x, 0);
				pitchCtx.lineTo(x, height);
				pitchCtx.stroke();
			}
		}
	}
}

// 再生カーソルが、音声の先頭・末端付近を除いて常にキャンバス（表示領域）の
// 中央に来るようスクロール位置を合わせる。先頭・末端ではスクロール量が
// 0や最大値でクランプされるため、その部分だけ中央からずれる。
function autoScrollToPlayhead(t) {
	const container = UI.pitchScrollContainer;
	const x = timeToX(t);
	setScrollLeftAndRender(x - container.clientWidth / 2);
}

// 最後まで再生し終えた際、チャートの右端（終端）を表示したままにする。
function scrollToRightEdge() {
	const container = UI.pitchScrollContainer;
	setScrollLeftAndRender(container.scrollWidth - container.clientWidth);
}

/* ********************************************************************************
 * ファイル再生・停止制御
 * ********************************************************************************/
function stopFilePlayback() {
	if (!audioEl.paused) audioEl.pause();
}

UI.playPauseBtn.addEventListener('click', () => {
	if (!fileAnalysisData) return;
	tryResumeAudioContexts();
	if (!audioEl.paused) {
		audioEl.pause();
	} else {
		stopMicPlayback();
		// 末尾まで再生済みの場合は、先頭から再生し直す
		if (audioEl.ended || audioEl.currentTime >= fileAnalysisData.duration - 0.02) {
			audioEl.currentTime = 0;
		}
		audioEl.play();
	}
});

audioEl.addEventListener('play', () => {
	UI.playPauseBtn.textContent = LITERALS.get('pause');
	requestAnimationFrame(updateFilePlayhead);
});
audioEl.addEventListener('pause', () => {
	UI.playPauseBtn.textContent = LITERALS.get('playPauseBtn');
	render();
});
audioEl.addEventListener('ended', () => {
	UI.playPauseBtn.textContent = LITERALS.get('playPauseBtn');
	scrollToRightEdge(); // 最後まで再生し終えた際は、チャートの右端（終端）を表示したままにする
});
audioEl.addEventListener('error', () => {
	console.error('audioEl error', audioEl.error);
	UI.statusDiv.textContent = LITERALS.get('filePlaybackError');
});

function updateFilePlayhead() {
	if (audioEl.paused) return;
	autoScrollToPlayhead(getFileTime());
	requestAnimationFrame(updateFilePlayhead);
}

/* ********************************************************************************
 * 録音関連の処理
 * ********************************************************************************/
function clearMicComparison() {
	stopMicPlayback();
	if (micObjectURL) {
		URL.revokeObjectURL(micObjectURL);
		micObjectURL = null;
	}
	micAudioEl.removeAttribute('src');
	micAnalysisData = null;
	micTimeOffset = 0;
	UI.micPlayPauseBtn.disabled = true;
	UI.micSpeedSlider.disabled = true;
	layoutAndRender();
}

const MIC_WORKLET_SOURCE = `
	class PCMCaptureProcessor extends AudioWorkletProcessor {
		constructor(options){
			super();
			this.chunkSize = (options && options.processorOptions && options.processorOptions.chunkSize) || 4096;
			this.buffer = new Float32Array(this.chunkSize);
			this.writeIndex = 0;
		}
		process(inputs){
			const input = inputs[0];
			if (input && input.length && input[0] && input[0].length){
				const channel = input[0];
				let i = 0;
				while (i < channel.length){
					const remaining = this.chunkSize - this.writeIndex;
					const toCopy = Math.min(remaining, channel.length - i);
					this.buffer.set(channel.subarray(i, i + toCopy), this.writeIndex);
					this.writeIndex += toCopy;
					i += toCopy;
					if (this.writeIndex >= this.chunkSize){
						this.port.postMessage(this.buffer.slice(0, this.writeIndex));
						this.writeIndex = 0;
					}
				}
			}
			return true;
		}
	}
	registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
`;
let micWorkletModuleUrl = null;
function getMicWorkletModuleUrl() {
	if (!micWorkletModuleUrl) {
		const blob = new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' });
		micWorkletModuleUrl = URL.createObjectURL(blob);
	}
	return micWorkletModuleUrl;
}

async function ensureMicContext() {
	if (!micAudioCtx) {
		micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
	}
	if (micAudioCtx.state === 'suspended') {
		await micAudioCtx.resume();
	}
}

UI.recordBtn.addEventListener('click', async () => {
	if (UI.recordBtn.disabled) return;
	if (!isRecording) {
		await startRecording();
	} else {
		await stopRecordingAndAnalyze();
	}
});

async function startRecording() {
	if (isRecording) return;
	try {
		await ensureMicContext();
		if (!micStream) {
			micStream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
			});
		}
		await micAudioCtx.audioWorklet.addModule(getMicWorkletModuleUrl());

		micNativeRate = micAudioCtx.sampleRate;
		micSourceNode = micAudioCtx.createMediaStreamSource(micStream);
		micWorkletNode = new AudioWorkletNode(micAudioCtx, 'pcm-capture-processor', {
			numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
		});
		// AudioWorkletNodeは、Web Audioのレンダーグラフが「実際に消費される終端」に
		// つながっていないと処理(process())が呼ばれない。以前はgain=0のノード経由で
		// ハードウェア出力(destination)につないでいたが、これだとマイク入力と
		// スピーカー出力が同時に有効な「フルデュプレックス」状態になり、特に
		// Androidでは機種によって音声入出力のハードウェア処理が競合し、録音音声に
		// ビビり音（クラック・歪み）が乗ることがある。実際にスピーカーへ音を出す
		// 必要は無いので、MediaStreamAudioDestinationNode（実際には音を出さない
		// 仮想の終端）につなぐことで、スピーカー出力を一切発生させずに済む。
		const silentSink = micAudioCtx.createMediaStreamDestination();

		micChunks = [];
		warmupSamplesToSkip = Math.round(RECORDING_WARMUP_SEC * micNativeRate);
		micWorkletNode.port.onmessage = (e) => {
			let chunk = e.data;
			if (warmupSamplesToSkip > 0) {
				if (chunk.length <= warmupSamplesToSkip) {
					// このチャンクは丸ごとウォームアップ区間なので捨てる
					warmupSamplesToSkip -= chunk.length;
					return;
				}
				// チャンクの前半だけウォームアップ区間なので、そこだけ切り捨てる
				chunk = chunk.subarray(warmupSamplesToSkip);
				warmupSamplesToSkip = 0;
			}
			micChunks.push(chunk);
		};

		micSourceNode.connect(micWorkletNode);
		micWorkletNode.connect(silentSink);

		isRecording = true;
		UI.recordBtn.classList.add('active');
		UI.recordBtn.innerHTML = LITERALS.get('recording1');
		UI.statusDiv.textContent = LITERALS.get('statusRecording');
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('micAccessError');
	}
}

async function stopRecordingAndAnalyze() {
	if (!isRecording) return;
	isRecording = false;
	UI.recordBtn.classList.remove('active');
	UI.recordBtn.innerHTML = LITERALS.get('recordBtn');

	try { micSourceNode.disconnect(); } catch (e) {}
	try { micWorkletNode.disconnect(); } catch (e) {}
	if (micWorkletNode) micWorkletNode.port.onmessage = null;

	// iOSでは、マイクの録音用オーディオセッション（PlayAndRecordカテゴリ）を開いた
	// ままにしておくと、その後の<audio>要素での再生が無音になったり、ルーティング
	// がおかしくなったりすることがある。録音が終わったら即座にマイクとAudioContext
	// を解放し、通常の再生用セッションに戻れるようにしておく。
	releaseMicResources();

	if (!micChunks.length) {
		UI.statusDiv.textContent = LITERALS.get('noRecData');
		return;
	}

	let total = 0;
	for (const c of micChunks) total += c.length;
	const merged = new Float32Array(total);
	let off = 0;
	for (const c of micChunks) { merged.set(c, off); off += c.length; }
	micChunks = []; // 用済みチャンクは解放

	if (merged.length / micNativeRate < MIN_RECORD_SEC) {
		UI.statusDiv.textContent = LITERALS.get('recTooShort');
		return;
	}

	// 再生用に軽量な16bit PCM WAVへ変換し、Audio要素にセットする（ネイティブレートのAudioBufferは保持しない）。
	const wavBlob = pcmToWavBlob(merged, micNativeRate);
	if (micObjectURL) URL.revokeObjectURL(micObjectURL);
	micObjectURL = URL.createObjectURL(wavBlob);
	micAudioEl.src = micObjectURL;
	micAudioEl.playbackRate = parseFloat(UI.micSpeedSlider.value);
	UI.micPlayPauseBtn.disabled = false;
	UI.micSpeedSlider.disabled = false;

	await analyzeMicRecording(merged, micNativeRate);
}

// マイクのトラックを止め、AudioContextも休止状態に戻す。次回録音時は
// startRecording() 内の ensureMicContext() / getUserMedia() で改めて確保し直す。
function releaseMicResources() {
	if (micStream) {
		micStream.getTracks().forEach((track) => track.stop());
		micStream = null;
	}
	if (micAudioCtx && micAudioCtx.state === 'running') {
		micAudioCtx.suspend().catch(() => {});
	}
}

// iOS等では、何らかの割り込み（電話・Siri・バックグラウンド化など）でAudioContext
// が意図せずsuspendされたままになることがある。実際のユーザー操作（クリック）の
// 中でresume()を試みておくと、そのまま無音状態が固定化するのを防ぎやすい。
function tryResumeAudioContexts() {
	if (micAudioCtx && micAudioCtx.state === 'suspended') {
		micAudioCtx.resume().catch(() => {});
	}
}
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') tryResumeAudioContexts();
});

async function analyzeMicRecording(nativeSamples, nativeRate) {
	if (!session) {
		UI.statusDiv.textContent = LITERALS.get('modelNotReady');
		return;
	}
	UI.statusDiv.textContent = LITERALS.get('analysingRec');
	try {
		const outLen = Math.max(1, Math.ceil(nativeSamples.length * TARGET_SR / nativeRate));
		const offlineCtx = new OfflineAudioContext(1, outLen, TARGET_SR);
		const src = offlineCtx.createBufferSource();
		const buf = offlineCtx.createBuffer(1, nativeSamples.length, nativeRate);
		buf.copyToChannel(nativeSamples, 0);
		src.buffer = buf;
		src.connect(offlineCtx.destination);
		src.start(0);
		const rendered = await offlineCtx.startRendering();
		const audio16k = rendered.getChannelData(0);

		if (audio16k.length < MIN_AUDIO_LENGTH) {
			UI.statusDiv.textContent = LITERALS.get('recTooShort');
			return;
		}

		const tensor = new ort.Tensor('float32', audio16k, [1, audio16k.length]);
		const out = await session.run({ input_audio: tensor });
		const pitchData = out.pitch_hz ? out.pitch_hz.data : Object.values(out)[0].data;
		const confData = out.confidence ? out.confidence.data : (out.f0_confidence ? out.f0_confidence.data : null);

		micAnalysisData = {
			pitchData: pitchData,
			confData: confData,
			duration: audio16k.length / TARGET_SR
		};
		micTimeOffset = 0;

		layoutAndRender();
		UI.statusDiv.textContent = `${LITERALS.get('finishMicAanalysing')}${micAnalysisData.duration.toFixed(2)}${LITERALS.get('sec')}${LITERALS.get('secClose')}`;
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('analysingRecError');
	}
}

// ネイティブレートのFloat32Arrayを16bit PCM WAVのBlobに変換する（再生用の一時ファイル）。
function pcmToWavBlob(samples, sampleRate) {
	const numChannels = 1;
	const bytesPerSample = 2;
	const blockAlign = numChannels * bytesPerSample;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	function writeString(offset, str) {
		for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
	}

	writeString(0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeString(8, 'WAVE');
	writeString(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true);
	writeString(36, 'data');
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < samples.length; i++, offset += 2) {
		let s = Math.max(-1, Math.min(1, samples[i]));
		s = s < 0 ? s * 0x8000 : s * 0x7fff;
		view.setInt16(offset, s, true);
	}

	return new Blob([buffer], { type: 'audio/wav' });
}

/* ********************************************************************************
 * マイク録音の再生・停止制御
 * ********************************************************************************/
function stopMicPlayback() {
	if (!micAudioEl.paused) micAudioEl.pause();
}

UI.micPlayPauseBtn.addEventListener('click', () => {
	if (!micObjectURL) return;
	tryResumeAudioContexts();
	if (!micAudioEl.paused) {
		micAudioEl.pause();
	} else {
		stopFilePlayback();
		// 末尾まで再生済みの場合は、先頭から再生し直す
		if (micAudioEl.ended || (micAnalysisData && micAudioEl.currentTime >= micAnalysisData.duration - 0.02)) {
			micAudioEl.currentTime = 0;
		}
		micAudioEl.play();
	}
});

micAudioEl.addEventListener('play', () => {
	UI.micPlayPauseBtn.textContent = LITERALS.get('pauseMicRec');
	requestAnimationFrame(updateMicPlayhead);
});
micAudioEl.addEventListener('pause', () => {
	UI.micPlayPauseBtn.textContent = LITERALS.get('micPlayPauseBtn');
	render();
});
micAudioEl.addEventListener('ended', () => {
	UI.micPlayPauseBtn.textContent = LITERALS.get('micPlayPauseBtn');
	// チャート全体の右端ではなく、マイクの再生カーソルの終端位置に表示を留める
	// （音声ファイルの方が長い場合に、ファイルの終端まで飛んでしまわないようにする）。
	if (micAnalysisData) {
		autoScrollToPlayhead(micAnalysisData.duration + micTimeOffset);
	} else {
		render();
	}
});
micAudioEl.addEventListener('error', () => {
	console.error('micAudioEl error', micAudioEl.error);
	UI.statusDiv.textContent = LITERALS.get('micPlaybackError');
});

function updateMicPlayhead() {
	if (micAudioEl.paused) return;
	autoScrollToPlayhead(getMicTime() + micTimeOffset);
	requestAnimationFrame(updateMicPlayhead);
}

/* ********************************************************************************
 * ピッチキャンバス上でのマイク波形位置ドラッグ操作
 * ********************************************************************************/
UI.pitchCanvas.addEventListener('pointerdown', (e) => {
	if (!micAnalysisData) return; // マイク録音が無ければドラッグしても何も起きない
	isDraggingMicOffset = true;
	const rect = UI.pitchCanvas.getBoundingClientRect();
	micOffsetDragStartX = e.clientX - rect.left;
	micOffsetDragStartValue = micTimeOffset;
	UI.pitchCanvas.style.cursor = 'ew-resize';
	try { UI.pitchCanvas.setPointerCapture(e.pointerId); } catch (err) {}
});

UI.pitchCanvas.addEventListener('pointermove', (e) => {
	if (!isDraggingMicOffset) return;
	const rect = UI.pitchCanvas.getBoundingClientRect();
	const canvasX = e.clientX - rect.left;
	const deltaPx = canvasX - micOffsetDragStartX;
	const deltaSec = deltaPx / PIXELS_PER_SECOND;
	micTimeOffset = micOffsetDragStartValue + deltaSec;
	layoutAndRender();
});

function endMicOffsetDrag() {
	if (!isDraggingMicOffset) return;
	isDraggingMicOffset = false;
	UI.pitchCanvas.style.cursor = 'default';
}
UI.pitchCanvas.addEventListener('pointerup', endMicOffsetDrag);
UI.pitchCanvas.addEventListener('pointercancel', endMicOffsetDrag);

UI.pitchCanvas.addEventListener('dblclick', () => {
	if (!micAnalysisData || micTimeOffset === 0) return;
	micTimeOffset = 0;
	layoutAndRender();
});
