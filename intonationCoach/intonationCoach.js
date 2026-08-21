import { SwiftF0model } from '../SwiftF0model/SwiftF0model.js';
import { LiteralsManager } from './LiteralsManager.js';

const paramObj = Object.fromEntries(new URLSearchParams(window.location.search));
const LANGUAGE = ('lang' in paramObj) ? paramObj.lang : 'jpn';

const LITERALS = new LiteralsManager(LANGUAGE);
LITERALS.setDOM();
// ---------------------------------------------------------------------
// SwiftF0の参照実装（Python）より
// ---------------------------------------------------------------------
const TARGET_SR = 16000;			// SwiftF0は16kHzのサンプリング周波数を要求している。
const HOP_LENGTH = 256;			// STFTのスライドサイズ（256/16000Hz=16m秒）
const FRAME_LENGTH = 1024;	// STFTのウィンドウサイズ（1024/16000Hz=64m秒）
const CENTER_OFFSET = (FRAME_LENGTH - 1) / 2 - (FRAME_LENGTH - HOP_LENGTH) / 2;
const MIN_AUDIO_LENGTH = 256;
const MIN_RECORD_SEC = 0.05; // 録音の最小長(これ未満は分析しない)
const pitchFMin = 50;					// drawPitchChartとanalysisDataToCsvが使用する描画周波数下限
const pitchFMax = 800;				// drawPitchChartとanalysisDataToCsvが使用する描画周波数上限

const DEFAULT_CONF = 0.90;		// 信頼度

// WebAudio周りの変数
let audioCtx = null;			// 入力ファイル用オーディオコンテキスト
let audioBuffer = null;		// 入力ファイル用オーディオバッファ
let sourceNode = null;		// 入力ファイル用オーディオソースノード
let monoWaveformData = null; // for drawing & analysis (downmixed native rate data)

// SwiftF0 ORT周りの変数
let session = null;			// SwiftF0 ORTのセッション

// 各種状態管理用の変数
let isPlaying = false;
let startTime = 0;
let pauseAt = 0.0; // 初期状態から0.0秒に設定

let playStartOffset = 0;
let playEndOffset = 0;

let viewStart = 0.0;
let viewEnd = 1.0;

let isDragging = false;
let dragMode = 'none';
let dragStartX = 0;
let dragCurrentX = 0;
let selectedRange = null;

let lastAnalysisData = null; // ファイル分析結果 {pitchData, confData, startSec, chunkDuration}

// --- マイク録音周りの状態変数 ---
// resizeCanvases() が定義直後に同期実行され、その中で micAnalysisData を
// 参照するため、宣言はこの場所に必要。
let micStream = null;
let micAudioCtx = null;
let micWorkletNode = null;
let micSourceNode = null;
let micNativeRate = 0;
let isRecording = false;
let micChunks = [];						// 録音時に使用するネイティブレートのFloat32Arrayチャンク
let micRecordedBuffer = null;		// 録音済み音声のバッファ(ネイティブレート、再生用)
let micAnalysisData = null;			// ファイル分析と同じ形式 {pitchData, confData, startSec:0, chunkDuration} 
let micPlaySourceNode = null;		// 録音音声再生用のソースノード

let micIsPlaying = false;
let micPlayStartCtxTime = 0;

// マイク録音表示の位置をドラッグするための管理変数
let micTimeOffset = 0;					// 表示上のみのオフセット(秒)。ファイル分析側は常に0のまま
let isDraggingMicOffset = false;
let micOffsetDragStartX = 0;
let micOffsetDragStartValue = 0;
let lastChartPlotWidth = 1;			// drawPitchChart() 内の (width-40) をドラッグ時のpx→秒換算に再利用
let lastChartDisplayDuration = 1;	// drawPitchChart() 内の displayDuration を同上の理由で保持

// ユーザーインタフェース周りのDOM
class UserInterfaceWidgets {
	constructor() {
		this.fileInput = document.getElementById('audioFile');
		this.playPauseBtn = document.getElementById('playPauseBtn');
		this.pitchPlayPauseBtn = document.getElementById('pitchPlayPauseBtn');
		this.zoomInBtn = document.getElementById('zoomInBtn');
		this.zoomOutBtn = document.getElementById('zoomOutBtn');
		this.resetZoomBtn = document.getElementById('resetZoomBtn');
		this.scrollLeftBtn = document.getElementById('scrollLeftBtn');
		this.scrollRightBtn = document.getElementById('scrollRightBtn');
		this.extractBtn = document.getElementById('extractBtn');
		this.waveCanvas = document.getElementById('waveformCanvas');
		this.pitchCanvas = document.getElementById('pitchCanvas');
		this.statusDiv = document.getElementById('status');
		this.recordBtn = document.getElementById('recordBtn');
		this.micPlayPauseBtn = document.getElementById('micPlayPauseBtn');
		this.outputWavBtn = document.getElementById('outputWavBtn');
		this.outputCsvBtn = document.getElementById('outputCsvBtn');

		this.confThresholdInput = document.getElementById('confThreshold');
		this.confValueSpan = document.getElementById('confValue');
		this.confLabel = document.getElementById('confLabel');
		this.confThresholdMicInput = document.getElementById('confThresholdMic');
		this.confValueMicSpan = document.getElementById('confValueMic');
		this.confLabelMic = document.getElementById('confLabelMic');
	}
}
const UI = new UserInterfaceWidgets();

// 描画用コンテキスト
const waveCtx = UI.waveCanvas.getContext('2d');
const pitchCtx = UI.pitchCanvas.getContext('2d');

/* ********************************************************************************
 * キャンバスのサイズ変更関連
 * ********************************************************************************/
function resizeCanvases() {
	const w1 = UI.waveCanvas.clientWidth;
	const w2 = UI.pitchCanvas.clientWidth;
	const h2 = UI.pitchCanvas.clientHeight;
	if (w1 === 0 || w2 === 0 || h2 === 0)
		return;
	UI.waveCanvas.width = w1 * window.devicePixelRatio;
	UI.waveCanvas.height = 200 * window.devicePixelRatio;
	UI.pitchCanvas.width = w2 * window.devicePixelRatio;
	UI.pitchCanvas.height = h2 * window.devicePixelRatio;

	if (audioBuffer) {
		drawWaveform();
	}
	if (lastAnalysisData || micAnalysisData) {
		drawPitchChart();
	} else {
		clearPitchChart();
	}
}
resizeCanvases();

let resizeTimeoutId = null;
function scheduleResize() {
	clearTimeout(resizeTimeoutId);
	resizeTimeoutId = setTimeout(resizeCanvases, 100);
}
const resizeObserver = new ResizeObserver(scheduleResize);
resizeObserver.observe(UI.waveCanvas.parentElement || UI.waveCanvas);
resizeObserver.observe(UI.pitchCanvas.parentElement || UI.pitchCanvas);

/* ********************************************************************************
 * confidence UI関連
 * ********************************************************************************/
UI.confThresholdInput.addEventListener('input', (e) => {
	const val = parseFloat(e.target.value);
	UI.confValueSpan.textContent = val.toFixed(2);
	if (lastAnalysisData || micAnalysisData) {
		drawPitchChart();
	}
});

// イベントリスナー - デフォルト値への変更
UI.confLabel.addEventListener('click', () => {
	UI.confThresholdInput.value = DEFAULT_CONF;
	UI.confValueSpan.textContent = DEFAULT_CONF.toFixed(2);
	if (lastAnalysisData || micAnalysisData) {
		drawPitchChart();
	}
});
UI.confLabel.title = LITERALS.get('confTips');
/* ********************************************************************************
 * マイク用 confidence UI関連
 * ********************************************************************************/
UI.confThresholdMicInput.addEventListener('input', (e) => {
	const val = parseFloat(e.target.value);
	UI.confValueMicSpan.textContent = val.toFixed(2);
	if (lastAnalysisData || micAnalysisData) {
		drawPitchChart();
	}
});

// イベントリスナー - デフォルト値への変更
UI.confLabelMic.addEventListener('click', () => {
	UI.confThresholdMicInput.value = DEFAULT_CONF;
	UI.confValueMicSpan.textContent = DEFAULT_CONF.toFixed(2);
	if (lastAnalysisData || micAnalysisData) {
		drawPitchChart();
	}
});
UI.confLabelMic.title = LITERALS.get('confTips');

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
 * ファイル入力 UI関連
 * ********************************************************************************/
// イベントリスナー - ファイル入力
UI.fileInput.addEventListener('change', async (e) => {
	const file = e.target.files[0];
	if (!file)
		return;

	UI.statusDiv.textContent = LITERALS.get('statusDecoding');
	if (!audioCtx)
		audioCtx = new (window.AudioContext || window.webkitAudioContext)();

	const arrayBuffer = await file.arrayBuffer();
	audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
	monoWaveformData = null;

	viewStart = 0;
	viewEnd = audioBuffer.duration;
	pauseAt = 0.0; // 読み込み時に明示的に先頭（0秒）を指定
	selectedRange = null;
	lastAnalysisData = null;
	clearMicComparison();		// ファイルを読み込んだらマイク録音の比較結果もリセットする

	UI.statusDiv.textContent = LITERALS.get('statusMixing');
	const duration = audioBuffer.duration;

	// calculate downmixed native rate data for drawWaveform.
	// This data region is reused whenever the analysis phase is invoked.
	{
		const numChannels = audioBuffer.numberOfChannels;
		const length = audioBuffer.length;
		if (numChannels > 1) {
			const mixed = new Float32Array(length);
			for (let ch = 0; ch < numChannels; ch++) {
				const chData = audioBuffer.getChannelData(ch);
				for (let i = 0; i < length; i++) {
					mixed[i] += chData[i] / numChannels;
				}
			}
			monoWaveformData = mixed;
		} else {
			monoWaveformData = audioBuffer.getChannelData(0);
		}
	}

	UI.playPauseBtn.disabled = false;
	UI.zoomInBtn.disabled = false;
	UI.zoomOutBtn.disabled = false;
	UI.resetZoomBtn.disabled = false;
	UI.scrollLeftBtn.disabled = false;
	UI.scrollRightBtn.disabled = false;
	UI.extractBtn.disabled = true;
	UI.pitchPlayPauseBtn.disabled = true;
	UI.outputWavBtn.disabled = true;
	UI.outputCsvBtn.disabled = true;

	UI.statusDiv.textContent = `${LITERALS.get('statusFinishReading')}${duration.toFixed(2)}${LITERALS.get('sec')}`;
	drawWaveform();
	if (micAnalysisData) drawPitchChart(); else clearPitchChart();
});

/* ********************************************************************************
 * ピッチ分析処理
 * ********************************************************************************/
async function extractAndAnalyzeBuffer(startTimeSec, endTimeSec) {
	UI.statusDiv.textContent = LITERALS.get('analysing');

	clearMicComparison();		// 範囲選択時、マイク録音の比較結果をリセットする

	// Perform capturing, downmixing, and resampling
	const nativeRate = audioBuffer.sampleRate;
	const startSample = Math.max(0, Math.floor(startTimeSec * nativeRate));
	const endSample = Math.min(monoWaveformData.length, Math.floor(endTimeSec * nativeRate));
	const nativeSegment = monoWaveformData.subarray(startSample, endSample);

	if (nativeSegment.length < 1) {
		UI.statusDiv.textContent = LITERALS.get('tooShort');
		return;
	}

	try {
		const outLen = Math.max(1, Math.ceil(nativeSegment.length * TARGET_SR / nativeRate));
		const offlineCtx = new OfflineAudioContext(1, outLen, TARGET_SR);
		const src = offlineCtx.createBufferSource();
		const buf = offlineCtx.createBuffer(1, nativeSegment.length, nativeRate);
		buf.copyToChannel(new Float32Array(nativeSegment), 0); // subarrayはビューなのでコピーしてから渡す
		src.buffer = buf;
		src.connect(offlineCtx.destination);
		src.start(0);
		const rendered = await offlineCtx.startRendering();
		const chunk = rendered.getChannelData(0);

		if (chunk.length < MIN_AUDIO_LENGTH) {
			UI.statusDiv.textContent = LITERALS.get('tooShort');
			return;
		}

		const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
		const out = await session.run({ input_audio: tensor });

		const pitchData = out.pitch_hz ? out.pitch_hz.data : Object.values(out)[0].data;
		const confData = out.confidence ? out.confidence.data : (out.f0_confidence ? out.f0_confidence.data : null);

		lastAnalysisData = {
			pitchData: pitchData,
			confData: confData,
			startSec: startTimeSec,
			chunkDuration: chunk.length / TARGET_SR
		};

		drawPitchChart();
		UI.pitchPlayPauseBtn.disabled = false;
		UI.outputWavBtn.disabled = false;
		UI.outputCsvBtn.disabled = false;
		UI.statusDiv.textContent = `${LITERALS.get('analysisFinished')}${startTimeSec.toFixed(2)}${LITERALS.get('sec')} 〜 ${endTimeSec.toFixed(2)}${LITERALS.get('sec')}`;
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('analysisError');
	}
}

/* ********************************************************************************
 * オシログラム描画関連
 * ********************************************************************************/
function drawWaveform() {
	if (!audioBuffer || !monoWaveformData) return;

	const width = UI.waveCanvas.width;
	const height = UI.waveCanvas.height;
	waveCtx.clearRect(0, 0, width, height);

	const waveHeight = height - 25;

	const sampleRate = audioBuffer.sampleRate;
	const rawData = monoWaveformData;

	const startIndex = Math.floor(viewStart * sampleRate);
	const endIndex = Math.floor(viewEnd * sampleRate);
	const totalSamples = endIndex - startIndex;
	const step = Math.ceil(totalSamples / width);

	waveCtx.strokeStyle = '#4af';		// Sky blue
	waveCtx.lineWidth = 1.5;
	waveCtx.beginPath();

	const middle = waveHeight / 2;
	for (let i = 0; i < width; i++) {
		const sampleIndex = startIndex + (i * step);
		if (sampleIndex >= rawData.length) break;

		let min = 1.0;
		let max = -1.0;

		for (let j = 0; j < step && (sampleIndex + j) < rawData.length; j++) {
			const val = rawData[sampleIndex + j];
			if (val < min) min = val;
			if (val > max) max = val;
		}

		const yMin = middle + (min * middle);
		const yMax = middle + (max * middle);

		waveCtx.moveTo(i, yMin);
		waveCtx.lineTo(i, yMax);
	}
	waveCtx.stroke();

	// 範囲選択されている領域の描画
	if (selectedRange) {
		const span = viewEnd - viewStart;
		const x1 = ((selectedRange.start - viewStart) / span) * width;
		const x2 = ((selectedRange.end - viewStart) / span) * width;
		waveCtx.fillStyle = 'rgba(255, 255, 0, 0.2)';		// Yellow w/ 0.2 alpha
		waveCtx.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), waveHeight);

		// 範囲選択の境界線
		waveCtx.strokeStyle = '#ff0';		// Yellow
		waveCtx.lineWidth = 2;
		waveCtx.beginPath();
		waveCtx.moveTo(x1, 0);
		waveCtx.lineTo(x1, waveHeight);
		waveCtx.moveTo(x2, 0);
		waveCtx.lineTo(x2, waveHeight);
		waveCtx.stroke();
	}

	// 範囲選択中の描画
	if (isDragging && dragMode === 'new' && !isPlaying) {
		waveCtx.fillStyle = 'rgba(255, 255, 255, 0.2)';		// White w/ 0.2 alpha
		const startX = Math.min(dragStartX, dragCurrentX);
		const widthX = Math.abs(dragCurrentX - dragStartX);
		waveCtx.fillRect(startX, 0, widthX, waveHeight);
	}

	// 再生中または停止位置(pauseAt)がある場合に赤線を描画
	const currentPlayTime = isPlaying ? (audioCtx.currentTime - startTime) : pauseAt;
	if (currentPlayTime >= viewStart && currentPlayTime <= viewEnd) {
		const x = ((currentPlayTime - viewStart) / (viewEnd - viewStart)) * width;
		waveCtx.strokeStyle = '#ff4444';		// Tomato
		waveCtx.lineWidth = 2;
		waveCtx.beginPath();
		waveCtx.moveTo(x, 0);
		waveCtx.lineTo(x, waveHeight);
		waveCtx.stroke();
	}

	// オシログラムと横軸見出しを区切る線分の描画
	waveCtx.strokeStyle = '#555';			// Gray
	waveCtx.lineWidth = 1;
	waveCtx.beginPath();
	waveCtx.moveTo(0, waveHeight);
	waveCtx.lineTo(width, waveHeight);
	waveCtx.stroke();

	// 目盛り間隔の設定
	const viewSpan = viewEnd - viewStart;
	let interval = 1.0;
	if (viewSpan <= 0.5) interval = 0.1;
	else if (viewSpan <= 2.0) interval = 0.5;
	else if (viewSpan <= 10.0) interval = 1.0;
	else if (viewSpan <= 30.0) interval = 5.0;
	else interval = 10.0;

	waveCtx.fillStyle = '#aaa';			// Light gray
	waveCtx.font = '10px sans-serif';
	waveCtx.textAlign = 'center';

	// 目盛りの描画
	const firstMark = Math.ceil(viewStart / interval) * interval;
	for (let t = firstMark; t <= viewEnd; t += interval) {
		const ratio = (t - viewStart) / viewSpan;
		const x = ratio * width;

		// 区切り線
		waveCtx.beginPath();
		waveCtx.moveTo(x, waveHeight);
		waveCtx.lineTo(x, waveHeight + 5);
		waveCtx.stroke();

		// 秒数
		let labelText = t.toFixed(1) + 's';
		if (interval >= 1.0) labelText = Math.round(t) + 's';
		waveCtx.fillText(labelText, x, waveHeight + 17);
	}
}

/* ********************************************************************************
 * ピッチチャートの描画
 * ********************************************************************************/
// ピッチチャートのクリア
function clearPitchChart() {
	const width = UI.pitchCanvas.width;
	const height = UI.pitchCanvas.height;
	pitchCtx.fillStyle = '#1e1e1e';
	pitchCtx.fillRect(0, 0, width, height);
}

// ピッチチャートの描画
// （ファイル分析結果(lastAnalysisData)とマイク録音結果(micAnalysisData)を
// 　　同じ実時間の軸(秒)の上に重ねて描画する。短い方は左詰めで収める。）
function drawPitchChart() {
	const width = UI.pitchCanvas.width;
	const height = UI.pitchCanvas.height;
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
		pitchCtx.moveTo(40, y);
		pitchCtx.lineTo(width, y);
		pitchCtx.stroke();
		pitchCtx.fillText(hz + 'Hz', 5, y + 4);
	});

	if (!lastAnalysisData && !micAnalysisData) return;

	// 両者とも「実際の秒数」を共有の時間軸として使う。
	// 軸の全長は長い方の区間に合わせるので、短い録音は左詰めになる。
	const fileDur = lastAnalysisData ? lastAnalysisData.chunkDuration : 0;
	const micDur = micAnalysisData ? micAnalysisData.chunkDuration : 0;
	const displayDuration = Math.max(fileDur, micDur, 0.001);

	// ドラッグ操作(px→秒の換算)で再利用するため保存しておく
	lastChartDisplayDuration = displayDuration;
	lastChartPlotWidth = width - 40;

	function plotSeries(analysisData, color, minConf, timeShift){
		if (!analysisData) return;
		const { pitchData, confData, chunkDuration } = analysisData;
		pitchCtx.fillStyle = color;
		pitchData.forEach((hz, i) => {
			const conf = confData ? confData[i] : 1.0;
			if (conf < minConf || hz < fmin || hz > fmax) return;

			// localTime: そのデータ自身の区間内での時刻(0〜chunkDuration)。
			// displayTime: 画面上の表示位置(マイク側はここにドラッグ分のオフセットが乗る)。
			const localTime = (i * HOP_LENGTH + CENTER_OFFSET) / TARGET_SR;
			if (localTime < 0 || localTime > chunkDuration) return;

			const displayTime = localTime + timeShift;
			if (displayTime < 0 || displayTime > displayDuration) return;	// 画面外にはみ出た部分は描画しない。

			const ratio = displayTime / displayDuration;
			const x = 40 + ratio * (width - 40);
			const frac = (Math.log2(hz) - Math.log2(fmin)) / (Math.log2(fmax) - Math.log2(fmin));
			const y = height - (frac * (height - 30) + 15);

			pitchCtx.beginPath();
			pitchCtx.arc(x, y, 2, 0, Math.PI * 2);
			pitchCtx.fill();
		});
	}

	plotSeries(lastAnalysisData, '#4af', parseFloat(UI.confThresholdInput.value), 0);	// ファイル分析: スカイブルー
	plotSeries(micAnalysisData, '#fa4', parseFloat(UI.confThresholdMicInput.value), micTimeOffset);	// マイク録音: オレンジ

	// ファイル分析範囲の再生カーソル(赤)は、displayDuration基準にスケールを合わせる
	if (lastAnalysisData) {
		const currentPlayTime = isPlaying ? (audioCtx.currentTime - startTime) : pauseAt;
		const relativeTime = currentPlayTime - lastAnalysisData.startSec;
		if (relativeTime >= 0 && relativeTime <= lastAnalysisData.chunkDuration) {
			const x = 40 + (relativeTime / displayDuration) * (width - 40);
			pitchCtx.strokeStyle = '#ff4444';
			pitchCtx.lineWidth = 2;
			pitchCtx.beginPath();
			pitchCtx.moveTo(x, 0);
			pitchCtx.lineTo(x, height);
			pitchCtx.stroke();
		}
	}

	// マイク録音の再生カーソル(黄色)は表示位置のドラッグ分と揃える
	if (micAnalysisData && micIsPlaying) {
		const micPlayTime = micAudioCtx.currentTime - micPlayStartCtxTime;
		const displayMicPlayTime = micPlayTime + micTimeOffset;
		if (displayMicPlayTime >= 0 && displayMicPlayTime <= displayDuration) {
			const x = 40 + (displayMicPlayTime / displayDuration) * (width - 40);
			pitchCtx.strokeStyle = '#ffd24a';
			pitchCtx.lineWidth = 2;
			pitchCtx.beginPath();
			pitchCtx.moveTo(x, 0);
			pitchCtx.lineTo(x, height);
			pitchCtx.stroke();
		}
	}
}

/* ********************************************************************************
 * 再生・停止制御関連
 * ********************************************************************************/
// 再生の停止
function stopAudio() {
	if (sourceNode) {
		try {
			sourceNode.stop();
		} catch(e) {}
		sourceNode.disconnect();
		sourceNode = null;
	}
	isPlaying = false;
	UI.playPauseBtn.textContent = LITERALS.get('playPause');
	UI.pitchPlayPauseBtn.textContent = LITERALS.get('rangePlayPause');
	if (lastAnalysisData || micAnalysisData) {
		drawPitchChart();
	}
}

// 再生の開始
function startPlayback(startTarget, durationTarget = undefined) {
	stopAudio();
	stopMicPlayback();		// 本編の再生が開始されたらマイク録音の再生を停止する。

	if (audioCtx.state === 'suspended') audioCtx.resume();
	if (startTarget >= audioBuffer.duration) startTarget = 0;

	sourceNode = audioCtx.createBufferSource();
	sourceNode.buffer = audioBuffer;
	sourceNode.connect(audioCtx.destination);

	startTime = audioCtx.currentTime - startTarget;
	playStartOffset = startTarget;
	playEndOffset = durationTarget ? (startTarget + durationTarget) : audioBuffer.duration;

	if (durationTarget) {
		sourceNode.start(0, startTarget, durationTarget);
	} else {
		sourceNode.start(0, startTarget);
	}

	isPlaying = true;
	UI.playPauseBtn.textContent = LITERALS.get('pause');
	UI.pitchPlayPauseBtn.textContent = LITERALS.get('rangePause');

	sourceNode.onended = () => {
		if (isPlaying) {
			stopAudio();
			pauseAt = durationTarget ? playStartOffset : 0;
			drawWaveform();
		}
	};

	requestAnimationFrame(updatePlayhead);
}

// 再生開始位置へのシーク
function seekPlayback(targetTime) {
	if (sourceNode) {
		try {
			sourceNode.onended = null;
			sourceNode.stop();
		} catch(e) {}
		sourceNode.disconnect();
		sourceNode = null;
	}
	stopMicPlayback();

	if (audioCtx.state === 'suspended')
		audioCtx.resume();
	if (targetTime >= audioBuffer.duration)
		targetTime = 0;

	sourceNode = audioCtx.createBufferSource();
	sourceNode.buffer = audioBuffer;
	sourceNode.connect(audioCtx.destination);

	startTime = audioCtx.currentTime - targetTime;
	playStartOffset = targetTime;

	sourceNode.start(0, targetTime);
	isPlaying = true;
	UI.playPauseBtn.textContent = LITERALS.get('pause');
	UI.pitchPlayPauseBtn.textContent = LITERALS.get('rangePause');

	sourceNode.onended = () => {
		if (isPlaying) {
			stopAudio();
			pauseAt = 0;
			drawWaveform();
		}
	};

	requestAnimationFrame(updatePlayhead);
}

// イベントリスナー - 再生／停止ボタン
UI.playPauseBtn.addEventListener('click', () => {
	if (!audioBuffer)
		return;

	if (isPlaying) {
		pauseAt = audioCtx.currentTime - startTime;
		stopAudio();
		drawWaveform();
	} else {
		let startTarget = pauseAt;
		let durationTarget = undefined;

		if (selectedRange) {
			startTarget = selectedRange.start;
			durationTarget = selectedRange.end - selectedRange.start;
			if (durationTarget <= 0)
				durationTarget = undefined;
		}

		startPlayback(startTarget, durationTarget);
	}
});

// イベントリスナー - 分析結果ビューの再生／停止ボタン
UI.pitchPlayPauseBtn.addEventListener('click', () => {
	if (!lastAnalysisData || !audioBuffer)
		return;

	if (isPlaying) {
		pauseAt = audioCtx.currentTime - startTime;
		stopAudio();
		drawWaveform();
	} else {
		startPlayback(lastAnalysisData.startSec, lastAnalysisData.chunkDuration);
	}
});

/* ********************************************************************************
 * 再生時の更新処理
 * ********************************************************************************/
function updatePlayhead() {
	if (!isPlaying)
		return;

	const currentPlayTime = audioCtx.currentTime - startTime;
	const viewSpan = viewEnd - viewStart;
	const duration = audioBuffer.duration;

	if (currentPlayTime >= duration || (selectedRange && currentPlayTime >= playEndOffset)) {
		return;
	}

	if (viewSpan < duration) {
		let newStart = currentPlayTime - viewSpan / 2;
		let newEnd = currentPlayTime + viewSpan / 2;

		if (newStart < 0) {
			newStart = 0;
			newEnd = viewSpan;
		} else if (newEnd > duration) {
			newEnd = duration;
			newStart = duration - viewSpan;
		}

		viewStart = newStart;
		viewEnd = newEnd;
	}

	drawWaveform();
	if (lastAnalysisData || micAnalysisData) {
		drawPitchChart();
	}
	requestAnimationFrame(updatePlayhead);
}

// イベントリスナー - キャンバス操作（moousedown）
UI.waveCanvas.addEventListener('mousedown', (e) => {
	if (!audioBuffer) return;
	const rect = UI.waveCanvas.getBoundingClientRect();
	const x = e.clientX - rect.left;
	const canvasX = x * (UI.waveCanvas.width / rect.width);

	const waveHeight = UI.waveCanvas.height - (25 * (UI.waveCanvas.height / rect.height));
	if (e.clientY - rect.top > (waveHeight / (UI.waveCanvas.height / rect.height))) return;

	isDragging = true;
	dragStartX = canvasX;
	dragCurrentX = canvasX;

	if (isPlaying) {
		const clickRatio = canvasX / UI.waveCanvas.width;
		const clickedTime = viewStart + clickRatio * (viewEnd - viewStart);

		pauseAt = clickedTime;
		selectedRange = null;
		UI.extractBtn.disabled = true;

		seekPlayback(clickedTime);
		drawWaveform();
		UI.statusDiv.textContent = `${LITERALS.get('alterPos')}${clickedTime.toFixed(2)}${LITERALS.get('sec')}`;
		return;
	}

	if (selectedRange) {
		const span = viewEnd - viewStart;
		const x1 = ((selectedRange.start - viewStart) / span) * UI.waveCanvas.width;
		const x2 = ((selectedRange.end - viewStart) / span) * UI.waveCanvas.width;
		const threshold = 8;

		if (Math.abs(canvasX - x1) <= threshold) {
			dragMode = 'resize-left';
			return;
		} else if (Math.abs(canvasX - x2) <= threshold) {
			dragMode = 'resize-right';
			return;
		}
	}

	dragMode = 'new';
});

// イベントリスナー - キャンバス操作（moousemove）
UI.waveCanvas.addEventListener('mousemove', (e) => {
	if (!audioBuffer) return;
	const rect = UI.waveCanvas.getBoundingClientRect();
	const x = e.clientX - rect.left;
	const canvasX = x * (UI.waveCanvas.width / rect.width);

	if (!isDragging && selectedRange) {
		const span = viewEnd - viewStart;
		const x1 = ((selectedRange.start - viewStart) / span) * UI.waveCanvas.width;
		const x2 = ((selectedRange.end - viewStart) / span) * UI.waveCanvas.width;
		const threshold = 8;

		if (Math.abs(canvasX - x1) <= threshold || Math.abs(canvasX - x2) <= threshold) {
			UI.waveCanvas.style.cursor = 'ew-resize';
		} else {
			UI.waveCanvas.style.cursor = 'crosshair';
		}
	}

	if (!isDragging)
		return;
	dragCurrentX = canvasX;

	if (isPlaying)
		return;

	const span = viewEnd - viewStart;

	if (dragMode === 'resize-left' && selectedRange) {
		const newTime = viewStart + (canvasX / UI.waveCanvas.width) * span;
		if (newTime < selectedRange.end) {
			selectedRange.start = Math.max(viewStart, newTime);
			UI.extractBtn.disabled = false;
			drawWaveform();
		}
	} else if (dragMode === 'resize-right' && selectedRange) {
		const newTime = viewStart + (canvasX / UI.waveCanvas.width) * span;
		if (newTime > selectedRange.start) {
			selectedRange.end = Math.min(viewEnd, newTime);
			UI.extractBtn.disabled = false;
			drawWaveform();
		}
	} else if (dragMode === 'new') {
		drawWaveform();
	}
});

// イベントリスナー - キャンバス操作（moouseup）
UI.waveCanvas.addEventListener('mouseup', (e) => {
	if (!isDragging)
		return;
	isDragging = false;
	UI.waveCanvas.style.cursor = 'crosshair';

	const rect = UI.waveCanvas.getBoundingClientRect();
	const endX = (e.clientX - rect.left) * (UI.waveCanvas.width / rect.width);
	const startX = dragStartX;
	const isClick = Math.abs(endX - startX) < 5;

	if (isPlaying) {
		dragMode = 'none';
		drawWaveform();
		return;
	}

	if (dragMode === 'resize-left' || dragMode === 'resize-right') {
		dragMode = 'none';
		UI.statusDiv.textContent = `${LITERALS.get('alterRange')}${selectedRange.start.toFixed(2)}${LITERALS.get('sec')} 〜 ${selectedRange.end.toFixed(2)}${LITERALS.get('sec')}`;
		return;
	}

	if (isClick) {
		const clickRatio = startX / UI.waveCanvas.width;
		const clickedTime = viewStart + clickRatio * (viewEnd - viewStart);

		pauseAt = clickedTime;
		selectedRange = null;
		UI.extractBtn.disabled = true;

		drawWaveform();
		UI.statusDiv.textContent = `${LITERALS.get('setPos')}${clickedTime.toFixed(2)}${LITERALS.get('sec')} ${LITERALS.get('inPause')}`;
	} else if (dragMode === 'new') {
		const ratio1 = Math.min(startX, endX) / UI.waveCanvas.width;
		const ratio2 = Math.max(startX, endX) / UI.waveCanvas.width;

		const timeStart = viewStart + ratio1 * (viewEnd - viewStart);
		const timeEnd = viewStart + ratio2 * (viewEnd - viewStart);

		selectedRange = { start: timeStart, end: timeEnd };
		UI.extractBtn.disabled = false;
		drawWaveform();

		UI.statusDiv.textContent = `${LITERALS.get('setRange')}${timeStart.toFixed(2)}${LITERALS.get('sec')} 〜 ${timeEnd.toFixed(2)}${LITERALS.get('sec')}`;
	}
	dragMode = 'none';
});

// イベントリスナー - 「切り出し＆分析」ボタンの処理
UI.extractBtn.addEventListener('click', async () => {
	if (!selectedRange || !monoWaveformData || !session) return;
	await extractAndAnalyzeBuffer(selectedRange.start, selectedRange.end);
});

/* ********************************************************************************
 * 拡大・縮小・リセット・スクロールボタンの処理
 * ********************************************************************************/
// イベントリスナー - ズームインボタン
UI.zoomInBtn.addEventListener('click', () => {
	if (!audioBuffer)
		return;
	const currentPos = isPlaying ? (audioCtx.currentTime - startTime) : pauseAt;
	const center = (currentPos >= viewStart && currentPos <= viewEnd) ? currentPos : (viewStart + viewEnd) / 2;

	const range = (viewEnd - viewStart) * 0.5;
	viewStart = Math.max(0, center - range / 2);
	viewEnd = Math.min(audioBuffer.duration, center + range / 2);

	if (viewEnd - viewStart < range) {
		if (viewStart === 0)
			viewEnd = Math.min(audioBuffer.duration, range);
		else if (viewEnd === audioBuffer.duration)
			viewStart = Math.max(0, audioBuffer.duration - range);
	}

	drawWaveform();
});

// イベントリスナー - ズームアウトボタン
UI.zoomOutBtn.addEventListener('click', () => {
	if (!audioBuffer)
		return;
	const currentPos = isPlaying ? (audioCtx.currentTime - startTime) : pauseAt;
	const center = (currentPos >= viewStart && currentPos <= viewEnd) ? currentPos : (viewStart + viewEnd) / 2;

	const range = (viewEnd - viewStart) * 2.0;
	viewStart = Math.max(0, center - range / 2);
	viewEnd = Math.min(audioBuffer.duration, center + range / 2);

	if (viewEnd - viewStart < range) {
		if (viewStart === 0)
			viewEnd = Math.min(audioBuffer.duration, range);
		else if (viewEnd === audioBuffer.duration)
			viewStart = Math.max(0, audioBuffer.duration - range);
	}

	drawWaveform();
});

// イベントリスナー - ズーム状態リセットボタン
UI.resetZoomBtn.addEventListener('click', () => {
	if (!audioBuffer)
		return;
	viewStart = 0;
	viewEnd = audioBuffer.duration;
	drawWaveform();
});

// イベントリスナー - 左スクロールボタン
UI.scrollLeftBtn.addEventListener('click', () => {
	if (!audioBuffer)
		return;
	const span = viewEnd - viewStart;
	const shift = span * 0.8;

	let newCenter = ((viewStart + viewEnd) / 2) - shift;
	if (newCenter - span / 2 < 0) {
		newCenter = span / 2;
	}

	viewStart = Math.max(0, newCenter - span / 2);
	viewEnd = Math.min(audioBuffer.duration, newCenter + span / 2);

	const currentPos = newCenter;
	if (isPlaying) {
		seekPlayback(currentPos);
	} else {
		pauseAt = currentPos;
	}

	drawWaveform();
});

// イベントリスナー - 右スクロールボタン
UI.scrollRightBtn.addEventListener('click', () => {
	if (!audioBuffer)
		return;
	const span = viewEnd - viewStart;
	const shift = span * 0.8;

	let newCenter = ((viewStart + viewEnd) / 2) + shift;
	if (newCenter + span / 2 > audioBuffer.duration) {
		newCenter = audioBuffer.duration - span / 2;
	}

	viewStart = Math.max(0, newCenter - span / 2);
	viewEnd = Math.min(audioBuffer.duration, newCenter + span / 2);

	const currentPos = Math.max(0, newCenter);
	if (isPlaying) {
		seekPlayback(currentPos);
	} else {
		pauseAt = currentPos;
	}

	drawWaveform();
});

/* ********************************************************************************
 * 録音関連の処理
 * ********************************************************************************/
// マイク録音側の表示・再生状態をまとめてリセットする
function clearMicComparison(){
	micAnalysisData = null;
	micRecordedBuffer = null;
	micTimeOffset = 0;
	UI.micPlayPauseBtn.disabled = true;
	if (micIsPlaying) stopMicPlayback(); // 内部で再描画も行われる
	else drawPitchChart();
}

// 状態変数は先頭で宣言済み（TDZ対策）

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
function getMicWorkletModuleUrl(){
	if (!micWorkletModuleUrl){
		const blob = new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' });
		micWorkletModuleUrl = URL.createObjectURL(blob);
	}
	return micWorkletModuleUrl;
}

// マイクコンテキストの保証
async function ensureMicContext(){
	if (!micAudioCtx){
		micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
	}
	if (micAudioCtx.state === 'suspended'){
		await micAudioCtx.resume();
	}
}

// イベントリスナー - 録音ボタンのpointerdown
UI.recordBtn.addEventListener('pointerdown', async (ev) => {
	if (UI.recordBtn.disabled || isRecording) return;
	ev.preventDefault();
	try{
		await ensureMicContext();
		if (!micStream){
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
		const silentGain = micAudioCtx.createGain(); silentGain.gain.value = 0;

		micChunks = [];
		micWorkletNode.port.onmessage = (e) => { micChunks.push(e.data); };

		micSourceNode.connect(micWorkletNode);
		micWorkletNode.connect(silentGain);
		silentGain.connect(micAudioCtx.destination);

		isRecording = true;
		UI.recordBtn.classList.add('active');
		UI.recordBtn.textContent = LITERALS.get('recording1');
		UI.statusDiv.textContent = LITERALS.get('statusRecording');
		try{ UI.recordBtn.setPointerCapture(ev.pointerId); }catch(e){}
	}catch(err){
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('micAccessError');
	}
});

// 録音ボタンリリース時の処理
async function onRecordRelease(){
	if (!isRecording) return;
	isRecording = false;
	UI.recordBtn.classList.remove('active');
	UI.recordBtn.textContent = LITERALS.get('recordBtn');

	try{ micSourceNode.disconnect(); }catch(e){}
	try{ micWorkletNode.disconnect(); }catch(e){}
	if (micWorkletNode) micWorkletNode.port.onmessage = null;

	if (!micChunks.length){
		UI.statusDiv.textContent = LITERALS.get('noRecData');
		return;
	}

	let total = 0;
	for (const c of micChunks) total += c.length;
	const merged = new Float32Array(total);
	let off = 0;
	for (const c of micChunks){ merged.set(c, off); off += c.length; }
	micChunks = [];

	if (merged.length / micNativeRate < MIN_RECORD_SEC){
		UI.statusDiv.textContent = LITERALS.get('recTooShort');
		return;
	}

	// 再生用にネイティブレートのままAudioBufferとして保持
	micRecordedBuffer = micAudioCtx.createBuffer(1, merged.length, micNativeRate);
	micRecordedBuffer.copyToChannel(merged, 0);
	UI.micPlayPauseBtn.disabled = false;

	await analyzeMicRecording(merged, micNativeRate);
}
UI.recordBtn.addEventListener('pointerup', onRecordRelease);
UI.recordBtn.addEventListener('pointercancel', onRecordRelease);

// 録音データの分析
async function analyzeMicRecording(nativeSamples, nativeRate){
	if (!session){
		UI.statusDiv.textContent = LITERALS.get('modelNotReady');
		return;
	}
	UI.statusDiv.textContent = LITERALS.get('analysingRec');
	try{
		// 16kHzへとダウンサンプリング
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

		if (audio16k.length < MIN_AUDIO_LENGTH){
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
			startSec: 0, // マイク録音自身の0秒起点
			chunkDuration: audio16k.length / TARGET_SR
		};

		drawPitchChart();
		UI.statusDiv.textContent = `${LITERALS.get('finishMicAanalysing')}(${micAnalysisData.chunkDuration.toFixed(2)}${LITERALS.get('sec')})`;
	}catch(err){
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('analysingRecError');
	}
}

// -Play/Pauseボタンのラベル設定
function updateMicPlayButtonUI(){
	UI.micPlayPauseBtn.textContent = micIsPlaying ? LITERALS.get('pauseMicRec') : LITERALS.get('micPlayPauseBtn');
}

// 録音データの再生
function playMicRecording(){
	if (!micRecordedBuffer) return;
	stopMicPlayback();
	if (isPlaying) stopAudio(); // 本編再生と重複しないよう止める

	const source = micAudioCtx.createBufferSource();
	source.buffer = micRecordedBuffer;
	source.connect(micAudioCtx.destination);
	micPlayStartCtxTime = micAudioCtx.currentTime;
	source.start(0);
	micPlaySourceNode = source;
	micIsPlaying = true;
	updateMicPlayButtonUI();

	source.onended = () => {
		micIsPlaying = false;
		micPlaySourceNode = null;
		updateMicPlayButtonUI();
		drawPitchChart();
	};
	requestAnimationFrame(updateMicPlayhead);
}

// 録音データの再生停止
function stopMicPlayback(){
	if (micPlaySourceNode){
		try{ micPlaySourceNode.onended = null; micPlaySourceNode.stop(); }catch(e){}
		micPlaySourceNode = null;
	}
	micIsPlaying = false;
	updateMicPlayButtonUI();
	if (lastAnalysisData || micAnalysisData) drawPitchChart();
}

// 録音再生時の更新処理
function updateMicPlayhead(){
	if (!micIsPlaying) return;
	drawPitchChart();
	requestAnimationFrame(updateMicPlayhead);
}

// イベントリスナー - Play/Pauseボタンの押下
UI.micPlayPauseBtn.addEventListener('click', () => {
	if (!micRecordedBuffer) return;
	if (micIsPlaying) stopMicPlayback();
	else playMicRecording();
});

/* ********************************************************************************
 * ピッチキャンバスのドラッグ操作
 * ********************************************************************************/
UI.pitchCanvas.addEventListener('pointerdown', (e) => {
	if (!micAnalysisData) return; // マイク録音が無ければドラッグしても何も起きない
	isDraggingMicOffset = true;
	const rect = UI.pitchCanvas.getBoundingClientRect();
	micOffsetDragStartX = (e.clientX - rect.left) * (UI.pitchCanvas.width / rect.width);
	micOffsetDragStartValue = micTimeOffset;
	UI.pitchCanvas.style.cursor = 'ew-resize';
	try{ UI.pitchCanvas.setPointerCapture(e.pointerId); }catch(err){}
});

// イベントリスナー - pointermove
UI.pitchCanvas.addEventListener('pointermove', (e) => {
	if (!isDraggingMicOffset) return;
	const rect = UI.pitchCanvas.getBoundingClientRect();
	const canvasX = (e.clientX - rect.left) * (UI.pitchCanvas.width / rect.width);
	const deltaPx = canvasX - micOffsetDragStartX;
	const secPerPx = lastChartDisplayDuration / lastChartPlotWidth;
	micTimeOffset = micOffsetDragStartValue + deltaPx * secPerPx;
	drawPitchChart();
});

// ドラッグの終了
function endMicOffsetDrag(){
	if (!isDraggingMicOffset) return;
	isDraggingMicOffset = false;
	UI.pitchCanvas.style.cursor = 'default';
}

// イベントリスナー
UI.pitchCanvas.addEventListener('pointerup', endMicOffsetDrag);
UI.pitchCanvas.addEventListener('pointercancel', endMicOffsetDrag);

// ダブルクリック(ダブルタップ)でオフセットを0に戻す
UI.pitchCanvas.addEventListener('dblclick', () => {
	if (!micAnalysisData || micTimeOffset === 0) return;
	micTimeOffset = 0;
	drawPitchChart();
});

/* ********************************************************************************
 * WAV / WebM / CSV 出力関連
 * ********************************************************************************/
// BLOBの出力
function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// イベントリスナー - WAVファイル出力ボタン (Shiftキー押下でWebM出力)
UI.outputWavBtn.addEventListener('click', async (evt) => {
	if (!lastAnalysisData || !audioBuffer) return;
	const { startSec, chunkDuration } = lastAnalysisData;
	try {
		let blob, extension;
		if (evt.shiftKey) {
			UI.statusDiv.textContent = LITERALS.get('writingWebM');
			blob = await audioBufferSegmentToWebM(audioBuffer, startSec, chunkDuration);
			extension = 'webm';
			UI.statusDiv.textContent = LITERALS.get('finishWritingWebM');
		} else {
			blob = audioBufferSegmentToWav(audioBuffer, startSec, startSec + chunkDuration);
			extension = 'wav';
		}
		downloadBlob(blob, `extract_${startSec.toFixed(2)}s-${(startSec+chunkDuration).toFixed(2)}s.${extension}`);
	} catch (err) {
		console.error(err);
		UI.statusDiv.textContent = LITERALS.get('writeSoundError') + err.message;
	}
});

// audioBuffer の [startSec, endSec) をWAV(16bit PCM)のBlobに変換する
function audioBufferSegmentToWav(audioBuffer, startSec, endSec) {
	const sampleRate = audioBuffer.sampleRate;
	const numChannels = audioBuffer.numberOfChannels;
	const startSample = Math.max(0, Math.floor(startSec * sampleRate));
	const endSample = Math.min(audioBuffer.length, Math.ceil(endSec * sampleRate));
	const frameCount = endSample - startSample;

	// チャンネルをインターリーブ処理（L,R,L,R,...）
	const interleaved = new Float32Array(frameCount * numChannels);
	for (let ch = 0; ch < numChannels; ch++) {
		const data = audioBuffer.getChannelData(ch);
		for (let i = 0; i < frameCount; i++) {
			interleaved[i * numChannels + ch] = data[startSample + i];
		}
	}

	// 16bit PCMへの変換処理
	const bytesPerSample = 2;
	const blockAlign = numChannels * bytesPerSample;
	const dataSize = interleaved.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	function writeString(offset, str) {
		for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
	}

	writeString(0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeString(8, 'WAVE');
	writeString(12, 'fmt ');
	view.setUint32(16, 16, true);		// fmtチャンクサイズ
	view.setUint16(20, 1, true);			// PCM形式
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);		// バイトレート
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true);		// ビット深度
	writeString(36, 'data');
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < interleaved.length; i++, offset += 2) {
		let s = Math.max(-1, Math.min(1, interleaved[i]));
		s = s < 0 ? s * 0x8000 : s * 0x7fff;
		view.setInt16(offset, s, true);
	}

	return new Blob([buffer], { type: 'audio/wav' });
}

/* ----------------------------------------------------------------------
 * WebM/OGGファイル出力処理
 * ---------------------------------------------------------------------- */
async function sliceAudioBuffer(audioBuffer, startTime, duration) {
	const sampleRate = audioBuffer.sampleRate;
	const frameCount = Math.ceil(duration * sampleRate);

	const offlineCtx = new OfflineAudioContext(
		audioBuffer.numberOfChannels,
		frameCount,
		sampleRate
	);

	const source = offlineCtx.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(offlineCtx.destination);
	source.start(0, startTime, duration);
	return await offlineCtx.startRendering();
}

async function audioBufferSegmentToWebM(audioBuffer, startSec, duration) {
	const mime = 'audio/webm';

	if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) {
		throw new Error(LITERALS.get('WebMnotSupported'));
	}

	const slicedBuffer = await sliceAudioBuffer(audioBuffer, startSec, duration);
	const webmAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

	if (webmAudioCtx.state === 'suspended') {
		await webmAudioCtx.resume();
	}

	const source = webmAudioCtx.createBufferSource();
	source.buffer = slicedBuffer;
	const destination = webmAudioCtx.createMediaStreamDestination();
	source.connect(destination);
	const recorder = new MediaRecorder(destination.stream, { mimeType: mime });
	const chunks = [];

	recorder.ondataavailable = (e) => {
		if (e.data.size > 0) {
			chunks.push(e.data);
		}
	};

	return new Promise((resolve, reject) => {
		recorder.onstop = () => {
			webmAudioCtx.close();
			resolve(new Blob(chunks, { type: mime }));
		};
		recorder.onerror = (e) => {
			webmAudioCtx.close();
			reject(e.error || new Error(LITERALS.get('mediaRecError')));
		};

		try {
			recorder.start();
			source.start(0);
		} catch (err) {
			webmAudioCtx.close();
			reject(err);
			return;
		}

		source.onended = () => {
			recorder.stop();
		};
	});
}

/* ----------------------------------------------------------------------
 * CSVファイル出力処理
 * ---------------------------------------------------------------------- */
// イベントリスナー - CSVファイル出力ボタン
UI.outputCsvBtn.addEventListener('click', () => {
	if (!lastAnalysisData) return;
	const { startSec, chunkDuration } = lastAnalysisData;
	const blob = analysisDataToCsv(lastAnalysisData);
	downloadBlob(blob, `extract_${startSec.toFixed(2)}s-${(startSec+chunkDuration).toFixed(2)}s.csv`);
});

// CSVデータの編集処理
function analysisDataToCsv(analysisData) {
	const { pitchData, confData, startSec, chunkDuration } = analysisData;
	const minConf = parseFloat(UI.confThresholdInput.value);
	const fmin = pitchFMin;
	const fmax = pitchFMax;

	const rows = ['frame,time_sec,time_sec_in_file,pitch_hz,confidence,voiced'];

	pitchData.forEach((hz, i) => {
		const conf = confData ? confData[i] : 1.0;
		const timeOffset = (i * HOP_LENGTH + CENTER_OFFSET) / TARGET_SR;
		const timeInFile = startSec + timeOffset;
		const voiced = (conf >= minConf && hz >= fmin && hz <= fmax) ? 1 : 0;

		rows.push([
			i,
			timeOffset.toFixed(4),
			timeInFile.toFixed(4),
			hz.toFixed(3),
			conf.toFixed(4),
			voiced
		].join(','));
	});

	// Excel(日本語環境)向けにUTF-8 BOMを付与
	return new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
}
