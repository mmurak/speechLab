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
		this.pitchPlotWrapper = document.getElementById('pitchPlotWrapper');
		this.pitchCanvas = document.getElementById('pitchCanvas');
		this.cursorCanvas = document.getElementById('cursorCanvas');
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
// pitchCtx: 音高の点群や目盛りなど「重い・頻繁には変わらない」描画（静的レイヤー）
// cursorCtx: 再生カーソルの線のみを描く「軽い・毎フレーム更新する」描画（動的レイヤー）
const pitchCtx = UI.pitchCanvas.getContext('2d');
const cursorCtx = UI.cursorCanvas.getContext('2d');

// カーソルの部分再描画のために、直前に描画したカーソルのx座標を記憶しておく
let lastFileCursorX = null;
let lastMicCursorX = null;

/* ********************************************************************************
 * キャンバスのサイズ変更関連
 * ********************************************************************************/
function computeTotalDuration() {
	const fileDur = fileAnalysisData ? fileAnalysisData.duration : 0;
	const micEnd = micAnalysisData ? (micTimeOffset + micAnalysisData.duration) : 0;
	return Math.max(fileDur, micEnd, 1.0);
}

function resizeCanvases() {
	const containerHeight = UI.pitchScrollContainer.clientHeight || 280;
	const containerWidth = UI.pitchScrollContainer.clientWidth || 300;
	const totalDuration = computeTotalDuration();
	const cssWidth = Math.max(containerWidth, PLOT_ORIGIN_X + totalDuration * PIXELS_PER_SECOND);
	const dpr = window.devicePixelRatio || 1;

	UI.pitchPlotWrapper.style.width = cssWidth + 'px';
	UI.pitchPlotWrapper.style.height = containerHeight + 'px';

	for (const [canvas, ctx] of [[UI.pitchCanvas, pitchCtx], [UI.cursorCanvas, cursorCtx]]) {
		canvas.style.width = cssWidth + 'px';
		canvas.style.height = containerHeight + 'px';
		canvas.width = Math.round(cssWidth * dpr);
		canvas.height = Math.round(containerHeight * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	// キャンバスの座標系が変わったので、カーソルの部分クリア用の記憶をリセットする
	lastFileCursorX = null;
	lastMicCursorX = null;

	if (fileAnalysisData || micAnalysisData) {
		drawStaticChart();
	} else {
		clearStaticChart();
	}
	drawCursors();
}
resizeCanvases();

// マイク波形のドラッグ中など、キャンバス全体のリサイズが不要な場合の軽量な再描画。
// 総時間が伸びてキャンバス幅そのものを広げる必要がある時だけ resizeCanvases() にフォールバックする。
function refreshChartAfterMicOffsetChange() {
	const containerWidth = UI.pitchScrollContainer.clientWidth || 300;
	const totalDuration = computeTotalDuration();
	const neededWidth = Math.max(containerWidth, PLOT_ORIGIN_X + totalDuration * PIXELS_PER_SECOND);
	const currentWidth = UI.pitchPlotWrapper.clientWidth;
	if (Math.abs(neededWidth - currentWidth) > 1) {
		resizeCanvases();
	} else {
		drawStaticChart();
		drawCursors();
	}
}

let resizeTimeoutId = null;
function scheduleResize() {
	clearTimeout(resizeTimeoutId);
	resizeTimeoutId = setTimeout(resizeCanvases, 100);
}
const resizeObserver = new ResizeObserver(scheduleResize);
resizeObserver.observe(UI.pitchScrollContainer);

/* ********************************************************************************
 * confidence UI関連
 * ********************************************************************************/
UI.confThresholdInput.addEventListener('input', (e) => {
	const val = parseFloat(e.target.value);
	UI.confValueSpan.textContent = val.toFixed(2);
	if (fileAnalysisData || micAnalysisData) drawStaticChart();
});
UI.confLabel.addEventListener('click', () => {
	UI.confThresholdInput.value = DEFAULT_CONF;
	UI.confValueSpan.textContent = DEFAULT_CONF.toFixed(2);
	if (fileAnalysisData || micAnalysisData) drawStaticChart();
});
UI.confLabel.title = LITERALS.get('confTips');

UI.confThresholdMicInput.addEventListener('input', (e) => {
	const val = parseFloat(e.target.value);
	UI.confValueMicSpan.textContent = val.toFixed(2);
	if (fileAnalysisData || micAnalysisData) drawStaticChart();
});
UI.confLabelMic.addEventListener('click', () => {
	UI.confThresholdMicInput.value = DEFAULT_CONF;
	UI.confValueMicSpan.textContent = DEFAULT_CONF.toFixed(2);
	if (fileAnalysisData || micAnalysisData) drawStaticChart();
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

	resizeCanvases();
	if (fileAnalysisData) {
		UI.playPauseBtn.disabled = false;
		UI.fileSpeedSlider.disabled = false;
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
 * ピッチチャートの描画
 * ---------------------------------------------------------------------------
 * スマホ等の非力な環境でも再生カーソルが遅れないよう、描画を2枚のキャンバスに
 * 分けている。
 *   pitchCanvas（静的レイヤー）: 目盛りと音高の点群。分析結果・信頼度・
 *     マイク位置のドラッグなど「状態が変わった時」だけ全体を再描画する。
 *     点の数が多い（長い音声）ほど重いが、毎フレーム描く必要はない。
 *   cursorCanvas（動的レイヤー）: 再生カーソルの線のみ。再生中は毎フレーム
 *     更新する必要があるが、前回線を引いた場所の周辺だけを消して描き直す
 *     ことで、音声の長さに関わらず一定の軽さで動作する。
 * ********************************************************************************/
function clearStaticChart() {
	const w = UI.pitchCanvas.clientWidth;
	const h = UI.pitchCanvas.clientHeight;
	pitchCtx.fillStyle = '#1e1e1e';
	pitchCtx.fillRect(0, 0, w, h);
}

function timeToX(t) {
	return PLOT_ORIGIN_X + t * PIXELS_PER_SECOND;
}

// 目盛りと音高の点群を描画する（重い処理。状態が変わった時だけ呼ぶ）
function drawStaticChart() {
	const width = UI.pitchCanvas.clientWidth;
	const height = UI.pitchCanvas.clientHeight;
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

	if (!fileAnalysisData && !micAnalysisData) return;

	function plotSeries(analysisData, color, minConf, timeShift) {
		if (!analysisData) return;
		const { pitchData, confData, duration } = analysisData;
		pitchCtx.fillStyle = color;
		for (let i = 0; i < pitchData.length; i++) {
			const hz = pitchData[i];
			const conf = confData ? confData[i] : 1.0;
			if (conf < minConf || hz < fmin || hz > fmax) continue;

			const localTime = (i * HOP_LENGTH + CENTER_OFFSET) / TARGET_SR;
			if (localTime < 0 || localTime > duration) continue;

			const displayTime = localTime + timeShift;
			if (displayTime < 0) continue;

			const x = timeToX(displayTime);
			const frac = (Math.log2(hz) - Math.log2(fmin)) / (Math.log2(fmax) - Math.log2(fmin));
			const y = height - (frac * (height - 30) + 15);

			pitchCtx.beginPath();
			pitchCtx.arc(x, y, 2, 0, Math.PI * 2);
			pitchCtx.fill();
		}
	}

	plotSeries(fileAnalysisData, '#4af', parseFloat(UI.confThresholdInput.value), 0);						// ファイル分析: スカイブルー
	plotSeries(micAnalysisData, '#fa4', parseFloat(UI.confThresholdMicInput.value), micTimeOffset);	// マイク録音: オレンジ
}

// 再生カーソルの線だけを描く（軽い処理。毎フレーム呼んでよい）。
// 前回線を引いた位置だけをピンポイントで消してから新しい位置に描くため、
// 音声の長さ（キャンバスの総幅）に関わらず処理コストはほぼ一定になる。
function drawCursors() {
	const height = UI.cursorCanvas.clientHeight;

	if (lastFileCursorX !== null) cursorCtx.clearRect(lastFileCursorX - 4, 0, 8, height);
	if (lastMicCursorX !== null) cursorCtx.clearRect(lastMicCursorX - 4, 0, 8, height);
	lastFileCursorX = null;
	lastMicCursorX = null;

	// ファイル再生カーソル（赤）
	if (fileAnalysisData && fileObjectURL) {
		const t = getFileTime();
		if (t >= 0 && t <= fileAnalysisData.duration) {
			const x = timeToX(t);
			cursorCtx.strokeStyle = audioEl.paused ? 'rgba(255,68,68,0.55)' : '#ff4444';
			cursorCtx.lineWidth = 2;
			cursorCtx.beginPath();
			cursorCtx.moveTo(x, 0);
			cursorCtx.lineTo(x, height);
			cursorCtx.stroke();
			lastFileCursorX = x;
		}
	}

	// マイク録音の再生カーソル（黄色）
	if (micAnalysisData && micObjectURL) {
		const t = getMicTime() + micTimeOffset;
		if (t >= 0 && t <= micAnalysisData.duration + micTimeOffset) {
			const x = timeToX(t);
			cursorCtx.strokeStyle = micAudioEl.paused ? 'rgba(255,210,74,0.55)' : '#ffd24a';
			cursorCtx.lineWidth = 2;
			cursorCtx.beginPath();
			cursorCtx.moveTo(x, 0);
			cursorCtx.lineTo(x, height);
			cursorCtx.stroke();
			lastMicCursorX = x;
		}
	}
}

// 再生カーソルが、音声の先頭・末端付近を除いて常にキャンバス（表示領域）の
// 中央に来るようスクロール位置を合わせる。先頭・末端ではスクロール量が
// 0や最大値でクランプされるため、その部分だけ中央からずれる。
function autoScrollToPlayhead(t) {
	const container = UI.pitchScrollContainer;
	const x = timeToX(t);
	const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
	const target = Math.max(0, Math.min(maxScrollLeft, x - container.clientWidth / 2));
	container.scrollLeft = target;
}

/* ********************************************************************************
 * ファイル再生・停止制御
 * ********************************************************************************/
function stopFilePlayback() {
	if (!audioEl.paused) audioEl.pause();
}

UI.playPauseBtn.addEventListener('click', () => {
	if (!fileAnalysisData) return;
	if (!audioEl.paused) {
		audioEl.pause();
	} else {
		stopMicPlayback();
		audioEl.play();
	}
});

audioEl.addEventListener('play', () => {
	UI.playPauseBtn.textContent = LITERALS.get('pause');
	requestAnimationFrame(updateFilePlayhead);
});
audioEl.addEventListener('pause', () => {
	UI.playPauseBtn.textContent = LITERALS.get('playPauseBtn');
	drawCursors();
});
audioEl.addEventListener('ended', () => {
	audioEl.currentTime = 0;
	UI.playPauseBtn.textContent = LITERALS.get('playPauseBtn');
	drawCursors();
	UI.pitchScrollContainer.scrollLeft = 0;
});
audioEl.addEventListener('error', () => {
	console.error('audioEl error', audioEl.error);
	UI.statusDiv.textContent = LITERALS.get('filePlaybackError');
});

function updateFilePlayhead() {
	if (audioEl.paused) return;
	drawCursors();
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
	resizeCanvases();
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

UI.recordBtn.addEventListener('pointerdown', async (ev) => {
	if (UI.recordBtn.disabled || isRecording) return;
	ev.preventDefault();
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
		const silentGain = micAudioCtx.createGain();
		silentGain.gain.value = 0;

		micChunks = [];
		micWorkletNode.port.onmessage = (e) => { micChunks.push(e.data); };

		micSourceNode.connect(micWorkletNode);
		micWorkletNode.connect(silentGain);
		silentGain.connect(micAudioCtx.destination);

		isRecording = true;
		UI.recordBtn.classList.add('active');
		UI.recordBtn.innerHTML = LITERALS.get('recording1');
		UI.statusDiv.textContent = LITERALS.get('statusRecording');
		try { UI.recordBtn.setPointerCapture(ev.pointerId); } catch (e) {}
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('micAccessError');
	}
});

async function onRecordRelease() {
	if (!isRecording) return;
	isRecording = false;
	UI.recordBtn.classList.remove('active');
	UI.recordBtn.innerHTML = LITERALS.get('recordBtn');

	try { micSourceNode.disconnect(); } catch (e) {}
	try { micWorkletNode.disconnect(); } catch (e) {}
	if (micWorkletNode) micWorkletNode.port.onmessage = null;

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
UI.recordBtn.addEventListener('pointerup', onRecordRelease);
UI.recordBtn.addEventListener('pointercancel', onRecordRelease);

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

		resizeCanvases();
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
	if (!micAudioEl.paused) {
		micAudioEl.pause();
	} else {
		stopFilePlayback();
		micAudioEl.play();
	}
});

micAudioEl.addEventListener('play', () => {
	UI.micPlayPauseBtn.textContent = LITERALS.get('pauseMicRec');
	requestAnimationFrame(updateMicPlayhead);
});
micAudioEl.addEventListener('pause', () => {
	UI.micPlayPauseBtn.textContent = LITERALS.get('micPlayPauseBtn');
	drawCursors();
});
micAudioEl.addEventListener('ended', () => {
	micAudioEl.currentTime = 0;
	UI.micPlayPauseBtn.textContent = LITERALS.get('micPlayPauseBtn');
	drawCursors();
	autoScrollToPlayhead(micTimeOffset);
});
micAudioEl.addEventListener('error', () => {
	console.error('micAudioEl error', micAudioEl.error);
	UI.statusDiv.textContent = LITERALS.get('micPlaybackError');
});

function updateMicPlayhead() {
	if (micAudioEl.paused) return;
	drawCursors();
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
	refreshChartAfterMicOffsetChange();
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
	refreshChartAfterMicOffsetChange();
});
