export class LiteralsManager {
	constructor(lang) {
		this.supportedLanguage = ['jpn', 'eng'];
		if (!this.supportedLanguage.includes(lang)) {
			alert('Specified language is not supported.');
			lang = 'jpn';
		}
		this.lang = lang;
		this.messagePool = {
			'playPauseBtn': {
				jpn: '💿再生',
				eng: '💿Play',
			},
			'recordBtn': {
				jpn: '🔴',
				eng: '🔴',
			},
			'recordBtnHint': {
				jpn: 'クリックで録音開始、再クリックで録音終了します。',
				eng: 'Click to start recording, click again to stop.',
			},
			'micPlayPauseBtn': {
				jpn: '🎤再生',
				eng: '🎤Play',
			},
			'legend01': {
				jpn: 'ファイル分析',
				eng: 'File Audio',
			},
			'legend02': {
				jpn: 'マイク録音',
				eng: 'Recorded Audio',
			},
			'confTips': {
				jpn: 'クリックしてデフォルト値(0.90)に戻す',
				eng: 'Click to reset (default=0.90)',
			},
			'confLabel': {
				jpn: '信頼度 ≧: ',
				eng: 'Confidence ≥',
			},
			'confLabelMic': {
				jpn: '信頼度 ≧: ',
				eng: 'Confidence ≥',
			},
			'speedLabel': {
				jpn: '速度:',
				eng: 'Speed:',
			},
			'speedLabelMic': {
				jpn: '速度:',
				eng: 'Speed:',
			},
			'hintText': {
				jpn: '※ マイク録音の波形（オレンジ）は左右にドラッグして位置を調整できます（ダブルクリックでリセット）。',
				eng: '※ Drag the recorded-audio trace (orange) left/right to align it. Double-click to reset.',
			},
			'footer': {
				jpn: 'このウェブアプリはLars Nieradzik氏のSwiftF0 (MIT License) と Microsoft の ONNX Runtime Web (MIT License) を使用しています。<br>· 音声はブラウザ内でのみ処理され、外部へは送信されません。',
				eng: 'This web app uses SwiftF0 by Lars Nieradzik (MIT License) and ONNX Runtime Web by Microsoft (MIT License). <br>· Audio is processed exclusively within the browser and is not transmitted to external servers.',
			},
			'status': {
				jpn: 'モデルを初期化中...',
				eng: 'Initialising model...',
			},
			'statusReady': {
				jpn: 'モデル準備完了。音声ファイルを選択するか、マイク録音を行ってください。',
				eng: 'SwiftF0 model is ready. Choose an audio file or record from the mic.',
			},
			'statusInitError': {
				jpn: 'モデルの初期化に失敗しました。',
				eng: 'Failed to initialise the model.',
			},
			'statusDecoding': {
				jpn: '音声をデコード中...',
				eng: 'Decoding sound file...',
			},
			'statusAnalysingFile': {
				jpn: 'ファイル全体を分析中...',
				eng: 'Analysing the whole file...',
			},
			'statusFileReady': {
				jpn: '分析完了（長さ: ',
				eng: 'Analysis finished (duration: ',
			},
			'sec': {
				jpn: '秒',
				eng: ' sec.',
			},
			'secClose': {
				jpn: '）',
				eng: ')',
			},
			'decodeError': {
				jpn: '音声ファイルのデコードに失敗しました。',
				eng: 'Failed to decode the audio file.',
			},
			'fileAnalysisError': {
				jpn: 'ファイルの分析に失敗しました、または音声が短すぎます。',
				eng: 'Failed to analyse the file, or the audio is too short.',
			},
			'filePlaybackError': {
				jpn: '再生に失敗しました。この端末・ブラウザでは対応していない音声形式の可能性があります。',
				eng: 'Playback failed. The audio format may not be supported on this device/browser.',
			},
			'micPlaybackError': {
				jpn: 'マイク録音の再生に失敗しました。',
				eng: 'Failed to play back the mic. recording.',
			},
			'pause': {
				jpn: '停止',
				eng: 'Pause',
			},
			'pauseMicRec': {
				jpn: '🎤停止',
				eng: '🎤Stop',
			},
			'recording1': {
				jpn: '🔴<br>録音中',
				eng: '🔴<br>Rec...',
			},
			'statusRecording': {
				jpn: '録音中... もう一度ボタンを押すと終了します。',
				eng: 'Recording...  Release the button to analyse.',
			},
			'micAccessError': {
				jpn: 'マイクにアクセスできませんでした。',
				eng: 'Could not access mic.',
			},
			'noRecData': {
				jpn: '録音データがありません。',
				eng: 'No recording data.',
			},
			'recTooShort': {
				jpn: '録音が短すぎます。',
				eng: 'Recording too short.',
			},
			'modelNotReady': {
				jpn: 'モデルの準備ができていません。',
				eng: 'Model not ready.',
			},
			'analysingRec': {
				jpn: '録音を分析中...',
				eng: 'Analysing mic. recording...',
			},
			'finishMicAanalysing': {
				jpn: 'マイク録音の分析完了（長さ: ',
				eng: 'Finished analysing mic. recording (duration: ',
			},
			'analysingRecError': {
				jpn: 'マイク録音の分析に失敗しました。',
				eng: 'Failed to analyse the mic. recording.',
			},
			'confValue': {
				jpn: '0.90',
				eng: '0.90',
			},
			'confValueMic': {
				jpn: '0.90',
				eng: '0.90',
			},
		};
	}
	get(id) {
		return this.messagePool[id][this.lang];
	}
	setDOM() {
		for (let id of Object.keys(this.messagePool)) {
			const obj = document.getElementById(id);
			if (obj) {
				obj.innerHTML = this.messagePool[id][this.lang];
			}
		}
	}
}
