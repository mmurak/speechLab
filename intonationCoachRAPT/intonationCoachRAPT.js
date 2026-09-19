const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('chartOverlay');
const overlayCtx = overlayCanvas.getContext('2d');
const playheadCanvas = document.getElementById('playhead');
const playheadCtx = playheadCanvas.getContext('2d');
const chartScrollEl = document.getElementById('chartScroll');
const chartSpacerEl = document.getElementById('chartSpacer');
const chartStackEl = document.getElementById('chartStack');
const customScrollbarTrack = document.getElementById('customScrollbarTrack');
const customScrollbarThumb = document.getElementById('customScrollbarThumb');
const recordBtn = document.getElementById('recordBtn');
const filePlayBtn = document.getElementById('filePlayBtn');
const micPlayBtn = document.getElementById('micPlayBtn');
const fileCsvBtn = document.getElementById('fileCsvBtn');
const micCsvBtn = document.getElementById('micCsvBtn');
const fileRateInput = document.getElementById('fileRate');
const fileRateValueEl = document.getElementById('fileRateValue');
const micRateInput = document.getElementById('micRate');
const micRateValueEl = document.getElementById('micRateValue');
const statusEl = document.getElementById('status');
const lowFreqInput = document.getElementById('lowFreq');
const highFreqInput = document.getElementById('highFreq');
const audioFileInput = document.getElementById('audioFileInput');
const fileButtonLabel = document.getElementById('fileButtonLabel');
const fileNameLabel = document.getElementById('fileNameLabel');

const CHART_MIN_HZ = 50;
const CHART_MAX_HZ = 500;
const LOG_MIN = Math.log2(CHART_MIN_HZ);
const LOG_MAX = Math.log2(CHART_MAX_HZ);
const CHART_HEIGHT = 200;				// キャンバスの高さ(CSSピクセル、固定)
const SCROLLBAR_HEIGHT = 16;		// 太くしたスクロールバー分の余白(CSSの::-webkit-scrollbarと合わせる)
const PIXELS_PER_SECOND = 150;		// 1秒あたりの表示幅。これより長い録音は横スクロールになる
const VISIBLE_MARGIN_SEC = 0.1;	 // 可視範囲の前後に余裕を持たせる時間(境界の点を取りこぼさないため)

const modelColor = new ModelColor();
const micColor = new MicColor();

// 有声点のRMSの最小/最大値を求め、カラーマップの正規化範囲として使う
function computeRmsRange(points) {
	let min = Infinity, max = -Infinity;
	for (const p of points) {
		if (p.fx > 0) {
			if (p.rms < min) min = p.rms;
			if (p.rms > max) max = p.rms;
		}
	}
	if (!isFinite(min)) { min = 0; max = 1; }
	if (max <= min) max = min + 1e-6;
	return { min, max };
}

let currentContentWidth = 0;	// 録音全体の論理幅(スクロール範囲の計算用、CSSピクセル)
let currentViewportWidth = 0; // 画面に見えている幅(キャンバスの実サイズ、CSSピクセル)

// 周波数(Hz)をキャンバス上のy座標に変換する(対数軸)
function freqToY(fx, height) {
	const clamped = Math.min(Math.max(fx, CHART_MIN_HZ), CHART_MAX_HZ);
	return height - (height * (Math.log2(clamped) - LOG_MIN)) / (LOG_MAX - LOG_MIN);
}

// 二分探索処理
function lowerBoundByTime(points, t) {
	let lo = 0, hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].time < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recording = false;
let recordStartTime = 0;
let elapsedTimerHandle = null;

let fileResult = null;	 // { points, duration, audioUrl } (音声ファイル)
let micResult = null;		// { points, duration, audioUrl } (マイク録音)
let micOffsetPx = 0;		 // マイクの曲線をドラッグでずらした量(ピクセル)

let fileSourceBlob = null;	// 再解析用に保持しておく元データ(ファイル)
let fileSourceLabel = '';
let micSourceBlob = null;	 // 再解析用に保持しておく元データ(マイク録音)
let micSourceLabel = '';

let filePlayheadTime = null; // ファイル再生位置(秒)。再生していない間はnull
let micPlayheadTime = null;	// マイク再生位置(秒)。再生していない間はnull

function setStatus(msg, isError) {
	statusEl.textContent = msg || '';
	statusEl.classList.toggle('error', Boolean(isError));
}

function layoutCanvas() {
	const viewportWidth = chartScrollEl.clientWidth;
	const duration = Math.max(fileResult ? fileResult.duration : 0, micResult ? micResult.duration : 0);
	currentContentWidth = Math.max(viewportWidth, Math.ceil(duration * PIXELS_PER_SECOND));
	currentViewportWidth = viewportWidth;

	chartScrollEl.style.height = (CHART_HEIGHT + SCROLLBAR_HEIGHT) + 'px';
	chartSpacerEl.style.width = currentContentWidth + 'px';
	chartStackEl.style.width = viewportWidth + 'px';
	chartStackEl.style.height = CHART_HEIGHT + 'px';

	// キャンバスの物理サイズは録音時間に関わらず「見えている幅」のみに固定する
	const dpr = window.devicePixelRatio || 1;
	for (const [c, context] of [[canvas, ctx], [overlayCanvas, overlayCtx], [playheadCanvas, playheadCtx]]) {
		c.style.width = viewportWidth + 'px';
		c.style.height = CHART_HEIGHT + 'px';
		c.width = viewportWidth * dpr;
		c.height = CHART_HEIGHT * dpr;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	// サイズが変わった以上、キャッシュされた「前回描画したスクロール位置」は無効にする
	lastRenderedScrollLeft = null;
	lastRenderedMicOffset = null;
	renderFrame();
}

// モノラル信号への変換
function toMonaural(audioBuffer) {
	const ch0 = audioBuffer.getChannelData(0);
	if (audioBuffer.numberOfChannels === 1) return ch0;
	const mono = new Float32Array(ch0.length);
	for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
		const data = audioBuffer.getChannelData(c);
		for (let i = 0; i < data.length; i++) mono[i] += data[i] / audioBuffer.numberOfChannels;
	}
	return mono;
}

function drawVisiblePoints(context, points, offsetPx, scrollLeft, viewportWidth, rmsMin, rmsMax, outline) {
	if (!points || points.length === 0) return;

	const tStart = (scrollLeft - offsetPx) / PIXELS_PER_SECOND - VISIBLE_MARGIN_SEC;
	const tEnd = (scrollLeft + viewportWidth - offsetPx) / PIXELS_PER_SECOND + VISIBLE_MARGIN_SEC;
	const startIdx = lowerBoundByTime(points, tStart);
	const endIdx = lowerBoundByTime(points, tEnd);

	const DOT_RADIUS = 1;
	const plotColor = (outline) ? micColor : modelColor;
	for (let i = startIdx; i < endIdx; i++) {
		const p = points[i];
		if (p.fx <= 0) continue;
		const x = p.time * PIXELS_PER_SECOND + offsetPx - scrollLeft;
		const y = freqToY(p.fx, CHART_HEIGHT);
		const norm = (p.rms - rmsMin) / (rmsMax - rmsMin);
		context.fillStyle = plotColor.getColor(norm);
		context.beginPath();
		context.arc(x, y, Math.round(DOT_RADIUS + norm * 2), 0, Math.PI * 2);
		context.fill();
	}
}

// ベースキャンバス: グリッド + ファイルのピッチ(可視範囲のみ)
function drawStaticChart() {
	const w = currentViewportWidth || chartScrollEl.clientWidth;
	const h = CHART_HEIGHT;
	const scrollLeft = chartScrollEl.scrollLeft;

	ctx.clearRect(0, 0, w, h);

	// 背景の周波数グリッド(50Hz刻み、対数軸)
	ctx.strokeStyle = '#1C2B32';
	ctx.fillStyle = '#5C6E75';
	ctx.font = '11px -apple-system, sans-serif';
	ctx.lineWidth = 1;
	for (let f = CHART_MIN_HZ; f <= CHART_MAX_HZ; f += 50) {
		const y = freqToY(f, h);
		ctx.beginPath();
		ctx.moveTo(0, Math.round(y) + 0.5);
		ctx.lineTo(w, Math.round(y) + 0.5);
		ctx.stroke();
		if (f % 100 === 0) ctx.fillText(f + 'Hz', 6, y - 4);
	}

	if (fileResult) {
		drawVisiblePoints(ctx, fileResult.points, 0, scrollLeft, w, fileResult.rmsMin, fileResult.rmsMax, false);
	}
}

function drawOverlayChart() {
	const w = currentViewportWidth || chartScrollEl.clientWidth;
	const h = CHART_HEIGHT;
	const scrollLeft = chartScrollEl.scrollLeft;

	overlayCtx.clearRect(0, 0, w, h);
	if (micResult) {
		drawVisiblePoints(overlayCtx, micResult.points, micOffsetPx, scrollLeft, w, micResult.rmsMin, micResult.rmsMax, true);
	}
}

function drawPlayheads() {
	const w = currentViewportWidth || chartScrollEl.clientWidth;
	const h = CHART_HEIGHT;
	const scrollLeft = chartScrollEl.scrollLeft;

	playheadCtx.clearRect(0, 0, w, h);
	playheadCtx.strokeStyle = '#E5484D';
	playheadCtx.lineWidth = 1.5;

	if (filePlayheadTime !== null) {
		const x = filePlayheadTime * PIXELS_PER_SECOND - scrollLeft;
		playheadCtx.beginPath();
		playheadCtx.moveTo(Math.round(x) + 0.5, 0);
		playheadCtx.lineTo(Math.round(x) + 0.5, h);
		playheadCtx.stroke();
	}

	// マイクの赤線は、オーバーレイのドラッグ位置(micOffsetPx)を基準に動く
	if (micPlayheadTime !== null) {
		const x = micPlayheadTime * PIXELS_PER_SECOND + micOffsetPx - scrollLeft;
		playheadCtx.beginPath();
		playheadCtx.moveTo(Math.round(x) + 0.5, 0);
		playheadCtx.lineTo(Math.round(x) + 0.5, h);
		playheadCtx.stroke();
	}
}

// ------------------------------------------------------------
// 再描画エントリポイント。
// ------------------------------------------------------------
let lastRenderedScrollLeft = null;
let lastRenderedMicOffset = null;

function renderFrame() {
	const scrollLeft = chartScrollEl.scrollLeft;
	const scrollChanged = scrollLeft !== lastRenderedScrollLeft;
	const micOffsetChanged = micOffsetPx !== lastRenderedMicOffset;

	if (scrollChanged) {
		drawStaticChart();
	}
	if (scrollChanged || micOffsetChanged) {
		drawOverlayChart();
	}
	lastRenderedScrollLeft = scrollLeft;
	lastRenderedMicOffset = micOffsetPx;

	drawPlayheads();
	updateCustomScrollbar();
}

// ユーザーがスクロールバー・トラックパッド等で直接スクロールした場合にも追従する
chartScrollEl.addEventListener('scroll', renderFrame);

function updateCustomScrollbar() {
	const trackWidth = customScrollbarTrack.clientWidth;
	const viewport = currentViewportWidth || chartScrollEl.clientWidth;
	const content = currentContentWidth || viewport;
	const maxScroll = Math.max(0, content - viewport);

	if (maxScroll <= 0 || trackWidth <= 0) {
		customScrollbarTrack.style.display = 'none';
		return;
	}
	customScrollbarTrack.style.display = '';

	const thumbWidth = Math.max(24, (viewport / content) * trackWidth);
	const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
	const thumbLeft = (chartScrollEl.scrollLeft / maxScroll) * maxThumbLeft;

	customScrollbarThumb.style.width = thumbWidth + 'px';
	customScrollbarThumb.style.left = thumbLeft + 'px';
}

let sbDragging = false;
let sbDragStartX = 0;
let sbDragStartScrollLeft = 0;

customScrollbarThumb.addEventListener('pointerdown', (e) => {
	e.stopPropagation();
	sbDragging = true;
	sbDragStartX = e.clientX;
	sbDragStartScrollLeft = chartScrollEl.scrollLeft;
	customScrollbarThumb.setPointerCapture(e.pointerId);
	customScrollbarThumb.classList.add('dragging');
});
customScrollbarThumb.addEventListener('pointermove', (e) => {
	if (!sbDragging) return;
	const trackWidth = customScrollbarTrack.clientWidth;
	const thumbWidth = customScrollbarThumb.offsetWidth;
	const maxThumbLeft = Math.max(1, trackWidth - thumbWidth);
	const viewport = currentViewportWidth || chartScrollEl.clientWidth;
	const content = currentContentWidth || viewport;
	const maxScroll = Math.max(1, content - viewport);

	const deltaPx = e.clientX - sbDragStartX;
	const deltaScroll = deltaPx * (maxScroll / maxThumbLeft);
	chartScrollEl.scrollLeft = Math.max(0, Math.min(maxScroll, sbDragStartScrollLeft + deltaScroll));
});
function endSbDrag(e) {
	if (!sbDragging) return;
	sbDragging = false;
	customScrollbarThumb.classList.remove('dragging');
	try { customScrollbarThumb.releasePointerCapture(e.pointerId); } catch (err) {}
}
customScrollbarThumb.addEventListener('pointerup', endSbDrag);
customScrollbarThumb.addEventListener('pointercancel', endSbDrag);

// トラックの、つまみ以外の部分を押した場合は、そこへ直接ジャンプする
customScrollbarTrack.addEventListener('pointerdown', (e) => {
	if (e.target === customScrollbarThumb) return; // つまみ側で処理済み
	const trackWidth = customScrollbarTrack.clientWidth;
	const thumbWidth = customScrollbarThumb.offsetWidth;
	const maxThumbLeft = Math.max(1, trackWidth - thumbWidth);
	const viewport = currentViewportWidth || chartScrollEl.clientWidth;
	const content = currentContentWidth || viewport;
	const maxScroll = Math.max(1, content - viewport);

	const rect = customScrollbarTrack.getBoundingClientRect();
	const clickX = e.clientX - rect.left;
	const targetThumbLeft = Math.max(0, Math.min(maxThumbLeft, clickX - thumbWidth / 2));
	chartScrollEl.scrollLeft = (targetThumbLeft / maxThumbLeft) * maxScroll;
});


function scrollToPlayhead(absoluteX) {
	const viewportWidth = chartScrollEl.clientWidth;
	let desiredScroll;
	if (absoluteX <= viewportWidth / 2) {
		desiredScroll = 0;
	} else if (absoluteX >= currentContentWidth - viewportWidth / 2) {
		desiredScroll = currentContentWidth - viewportWidth;
	} else {
		desiredScroll = absoluteX - viewportWidth / 2;
	}
	desiredScroll = Math.max(0, desiredScroll);
	if (Math.abs(chartScrollEl.scrollLeft - desiredScroll) > 0.5) {
		chartScrollEl.scrollLeft = desiredScroll;
	}
}

// ------------------------------------------------------------
// オーバーレイのドラッグ操作
// ------------------------------------------------------------
let dragging = false;
let dragStartX = 0;
let dragStartOffset = 0;

overlayCanvas.addEventListener('pointerdown', (e) => {
	if (!micResult) return;
	dragging = true;
	dragStartX = e.clientX;
	dragStartOffset = micOffsetPx;
	overlayCanvas.setPointerCapture(e.pointerId);
	overlayCanvas.classList.add('dragging');
});
overlayCanvas.addEventListener('pointermove', (e) => {
	if (!dragging) return;
	micOffsetPx = dragStartOffset + (e.clientX - dragStartX);
	renderFrame();
});
function endDrag(e) {
	if (!dragging) return;
	dragging = false;
	overlayCanvas.classList.remove('dragging');
	try { overlayCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
}
overlayCanvas.addEventListener('pointerup', endDrag);
overlayCanvas.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------
// 再生コントローラのファクトリ
// ------------------------------------------------------------
function createPlaybackController({ getResult, button, idleLabel, onTick, onStop }) {
	const audioEl = new Audio();
	audioEl.preload = 'auto';
	let playing = false;
	let rafHandle = null;
	let currentRate = 1;

	audioEl.addEventListener('ended', () => { if (playing) stop(false); });

	function applyPitchPreservation() {
		// ブラウザによってプロパティ名が異なるため、存在するものすべてに設定しておく
		audioEl.preservesPitch = true;
		audioEl.mozPreservesPitch = true;
		audioEl.webkitPreservesPitch = true;
	}

	function toggle() {
		if (playing) { stop(true); return; }
		const result = getResult();
		if (!result || !result.audioUrl) return;

		if (audioEl.src !== result.audioUrl) {
			audioEl.src = result.audioUrl;
		}
		audioEl.currentTime = 0;
		applyPitchPreservation();
		audioEl.playbackRate = currentRate;

		playing = true;
		button.textContent = '再生を中止';
		button.classList.add('playing');
		chartScrollEl.scrollLeft = 0;
		audioEl.play();
		rafHandle = requestAnimationFrame(tick);
	}

	function tick() {
		if (!playing) return;
		onTick(audioEl.currentTime);
		rafHandle = requestAnimationFrame(tick);
	}

	function stop(userInitiated) {
		playing = false;
		if (rafHandle) cancelAnimationFrame(rafHandle);
		if (userInitiated) audioEl.pause();
		button.textContent = idleLabel;
		button.classList.remove('playing');
		onStop();
	}

	function setRate(rate) {
		currentRate = rate;
		audioEl.playbackRate = rate; // 再生中ならその場で反映される
	}

	return { toggle, stop, setRate, isPlaying: () => playing };
}

const filePlayer = createPlaybackController({
	getResult: () => fileResult,
	button: filePlayBtn,
	idleLabel: 'ファイルを再生',
	onTick: (t) => {
		filePlayheadTime = t;
		scrollToPlayhead(t * PIXELS_PER_SECOND);
		renderFrame();
	},
	onStop: () => {
		filePlayheadTime = null;
		renderFrame();
	}
});

const micPlayer = createPlaybackController({
	getResult: () => micResult,
	button: micPlayBtn,
	idleLabel: '録音音声を再生',
	onTick: (t) => {
		micPlayheadTime = t;
		// マイクの赤線はオーバーレイのドラッグ位置(micOffsetPx)を基準に動くため、
		// スクロール判定にも同じ絶対座標を使う
		scrollToPlayhead(t * PIXELS_PER_SECOND + micOffsetPx);
		renderFrame();
	},
	onStop: () => {
		micPlayheadTime = null;
		renderFrame();
	}
});

filePlayBtn.addEventListener('click', () => filePlayer.toggle());
micPlayBtn.addEventListener('click', () => micPlayer.toggle());

// ------------------------------------------------------------
// 検出結果のCSV出力。
// ------------------------------------------------------------
function exportCsv(result, filenamePrefix) {
	if (!result) return;
	const lines = ['frame,time_sec,time_sec,pitch_hz,confidence,voiced,rms'];
	result.points.forEach((p, i) => {
		const voiced = p.fx > 0 ? 1 : 0;
		const confidence = p.vs.toFixed(4);
		const pitch = p.fx.toFixed(2);
		const time = p.time.toFixed(4);
		const rms = p.rms.toFixed(6);
		lines.push(`${i},${time},${time},${pitch},${confidence},${voiced},${rms}`);
	});
	const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${filenamePrefix}_pitch.csv`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

fileCsvBtn.addEventListener('click', () => exportCsv(fileResult, 'file'));
micCsvBtn.addEventListener('click', () => exportCsv(micResult, 'mic'));

fileRateInput.addEventListener('input', () => {
	const rate = parseFloat(fileRateInput.value);
	fileRateValueEl.textContent = rate.toFixed(2) + 'x';
	filePlayer.setRate(rate);
});
micRateInput.addEventListener('input', () => {
	const rate = parseFloat(micRateInput.value);
	micRateValueEl.textContent = rate.toFixed(2) + 'x';
	micPlayer.setRate(rate);
});

// ------------------------------------------------------------
// 共通解析処理
// ------------------------------------------------------------
async function analyzeArrayBuffer(arrayBuffer, sourceBlob, label, target, { resetMicOffset = true } = {}) {
	const fLow = Number(lowFreqInput.value);
	const fHigh = Number(highFreqInput.value);
	if (!(fLow > 0) || !(fHigh > fLow)) {
		setStatus('下限・上限の値を確認してください', true);
		return;
	}

	if (filePlayer.isPlaying()) filePlayer.stop(true);
	if (micPlayer.isPlaying()) micPlayer.stop(true);

	setStatus('解析中(RAPT)... 少し時間がかかります');
	recordBtn.disabled = true;
	filePlayBtn.disabled = true;
	micPlayBtn.disabled = true;
	fileCsvBtn.disabled = true;
	micCsvBtn.disabled = true;
	fileButtonLabel.classList.add('disabled');

	let decodeCtx = null;
	try {
		decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
		const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
		const signal = toMonaural(audioBuffer);

		const tracker = new RaptPitchTracker({
			fMin: fLow * 0.8,
			fMax: fHigh * 1.3,
			sampleRate: audioBuffer.sampleRate
		});

		// 解析はやや重いため、描画をブロックしないようにする
		await new Promise(resolve => setTimeout(resolve, 0));
		const points = tracker.analyze(signal);
		const audioUrl = URL.createObjectURL(sourceBlob);
		const { min: rmsMin, max: rmsMax } = computeRmsRange(points);

		if (target === 'mic') {
			if (micResult) URL.revokeObjectURL(micResult.audioUrl);
			micResult = { points, duration: audioBuffer.duration, audioUrl, rmsMin, rmsMax };
			micSourceBlob = sourceBlob;
			micSourceLabel = label;
			if (resetMicOffset) micOffsetPx = 0; // 新しい録音では位置合わせをリセットする
		} else {
			if (fileResult) URL.revokeObjectURL(fileResult.audioUrl);
			fileResult = { points, duration: audioBuffer.duration, audioUrl, rmsMin, rmsMax };
			fileSourceBlob = sourceBlob;
			fileSourceLabel = label;
		}

		setStatus('解析完了: ' + trimFilename(label, 15) + '(' + audioBuffer.duration.toFixed(2) + '秒)');
		layoutCanvas();
	} catch (err) {
		setStatus('解析できませんでした: ' + err.message, true);
	} finally {
		if (decodeCtx) decodeCtx.close();
		recordBtn.disabled = false;
		filePlayBtn.disabled = !fileResult;
		micPlayBtn.disabled = !micResult;
		fileCsvBtn.disabled = !fileResult;
		micCsvBtn.disabled = !micResult;
		fileButtonLabel.classList.remove('disabled');
	}
}

// ------------------------------------------------------------
// マイク録音: MediaRecorderと解析
// ------------------------------------------------------------
async function startRecording() {
	if (filePlayer.isPlaying()) filePlayer.stop(true);
	if (micPlayer.isPlaying()) micPlayer.stop(true);

	try {
		mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
		});
	} catch (err) {
		setStatus('マイクにアクセスできませんでした: ' + err.message, true);
		return;
	}

	recordedChunks = [];
	mediaRecorder = new MediaRecorder(mediaStream);
	mediaRecorder.ondataavailable = (e) => {
		if (e.data && e.data.size > 0) recordedChunks.push(e.data);
	};
	mediaRecorder.onstop = async () => {
		mediaStream.getTracks().forEach(t => t.stop());
		const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
		const arrayBuffer = await blob.arrayBuffer();
		await analyzeArrayBuffer(arrayBuffer, blob, '録音した音声', 'mic');
	};

	mediaRecorder.start();
	recording = true;
	recordStartTime = performance.now();
	recordBtn.textContent = '録音終了';
	recordBtn.classList.add('recording');
	lowFreqInput.disabled = true;
	highFreqInput.disabled = true;
	fileButtonLabel.classList.add('disabled');

	elapsedTimerHandle = setInterval(() => {
		const sec = (performance.now() - recordStartTime) / 1000;
		setStatus('録音中... ' + sec.toFixed(1) + '秒');
	}, 200);
	setStatus('録音中... 0.0秒');
}

function stopRecording() {
	recording = false;
	clearInterval(elapsedTimerHandle);
	recordBtn.textContent = '録音開始';
	recordBtn.classList.remove('recording');
	lowFreqInput.disabled = false;
	highFreqInput.disabled = false;
	fileButtonLabel.classList.remove('disabled');
	if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

recordBtn.addEventListener('click', () => {
	recordBtn.classList.toggle('recording');
	if (recording) stopRecording();
	else startRecording();
});

// 録音の解析結果・オーバーレイキャンバスの内容・再生用データを破棄する
function discardMicResult() {
	if (micPlayer.isPlaying()) micPlayer.stop(true);
	if (micResult) URL.revokeObjectURL(micResult.audioUrl);
	micResult = null;
	micSourceBlob = null;
	micSourceLabel = '';
	micOffsetPx = 0;
	micPlayheadTime = null;
	micPlayBtn.disabled = true;
	micCsvBtn.disabled = true;
	layoutCanvas(); // オーバーレイキャンバスをクリア
}

function trimFilename(str, n) {
	const noc = Math.floor((n - 3) / 2);
	const additional = ((n % 2) == 0) ? 1 : 0;
	return str.substr(0, noc+additional) + '...' + str.substr(-noc);
}

audioFileInput.addEventListener('change', async (e) => {
	if (filePlayer.isPlaying()) filePlayer.stop(true);
	const file = e.target.files[0];
	if (!file) return;

	// ファイルを読み込み時は、マイク録音キャンバスを破棄する
	discardMicResult();

	fileNameLabel.textContent = trimFilename(file.name, 15);
	const arrayBuffer = await file.arrayBuffer();
	await analyzeArrayBuffer(arrayBuffer, file, file.name, 'file');
});

// 周波数の下限・上限の変更
async function reanalyzeWithCurrentRange() {
	if (fileSourceBlob) {
		const arrayBuffer = await fileSourceBlob.arrayBuffer();
		await analyzeArrayBuffer(arrayBuffer, fileSourceBlob, fileSourceLabel, 'file');
	}
	if (micSourceBlob) {
		const arrayBuffer = await micSourceBlob.arrayBuffer();
		await analyzeArrayBuffer(arrayBuffer, micSourceBlob, micSourceLabel, 'mic', { resetMicOffset: false });
	}
}

lowFreqInput.addEventListener('change', reanalyzeWithCurrentRange);
highFreqInput.addEventListener('change', reanalyzeWithCurrentRange);

window.addEventListener('resize', layoutCanvas);
layoutCanvas();
