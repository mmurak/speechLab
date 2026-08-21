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
				jpn: '再生 / 停止',
				eng: 'Play / Pause',
			},
			'zoomInBtn': {
				jpn: '拡大 (+)',
				eng: 'Expand (+)',
			},
			'zoomOutBtn': {
				jpn: '縮小 (-)',
				eng: 'shrink (-)',
			},
			'resetZoomBtn': {
				jpn: '全体表示リセット',
				eng: 'Show all',
			},
			'extractBtn': {
				jpn: '選択範囲を切り出し＆分析',
				eng: 'Extract the region &amp; Analyse',
			},
			'HeaderOscillogram': {
				jpn: 'オシログラム',
				eng: 'Oscillogram',
			},
			'HeaderPitchChart': {
				jpn: 'SwiftF0 ピッチ分析結果 (Hz)',
				eng: 'Pitch Analysis by SwiftF0',
			},
			'pitchPlayPauseBtn': {
				jpn: '分析範囲 再生 / 停止',
				eng: 'Play / Pause analysis range',
			},
			'recordBtn': {
				jpn: '🎤 マイク録音 （長押し）',
				eng: '🎤 Hold to Record Audio',
			},
			'micPlayPauseBtn': {
				jpn: 'マイク録音 再生 / 停止',
				eng: 'Mic Recording: Play / Stop',
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
			'outputWavBtn': {
				jpn: 'WAVファイル出力',
				eng: 'Output WAV file',
			},
			'outputCsvBtn': {
				jpn: 'F<sub>0</sub>情報（CSV）出力',
				eng: 'Output F<sub>0</sub> information (CSV)',
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
				jpn: 'モデル準備完了。音声を読み込んでください。',
				eng: 'SwiftF0 Model is ready.',
			},
			'statusInitError': {
				jpn: 'モデルの初期化に失敗しました。',
				eng: 'Failed to initialise the model.',
			},
			'statusDecoding': {
				jpn: '音声をデコード中...',
				eng: 'Decoding sound file...',
			},
			'statusMixing': {
				jpn: '波形データを準備中...',
				eng: 'Preparing Waveform...',
			},
			'statusFinishReading': {
				jpn: '読み込み完了: ',
				eng: 'Finish reading: ',
			},
			'sec': {
				jpn: '秒',
				eng: ' sec.',
			},
			'analysing': {
				jpn: '選択範囲を分析中...',
				eng: 'Analysing the region...',
			},
			'tooShort': {
				jpn: '選択範囲が短すぎます。',
				eng: 'Region too short.',
			},
			'analysisFinished': {
				jpn: '分析完了: ',
				eng: 'Analysing finished.',
			},
			'analysisError': {
				jpn: '分析エラーが発生しました。',
				eng: 'Analysing error.',
			},
			'playPause': {
				jpn: '再生 / 停止',
				eng: 'Play / Pause',
			},
			'rangePlayPause': {
				jpn: '分析範囲 再生 / 停止',
				eng: 'Analysing range  Play / Pause',
			},
			'pause': {
				jpn: '停止',
				eng: 'Pause',
			},
			'rangePause': {
				jpn: '分析範囲 停止',
				eng: 'analysing range  pause',
			},
			'alterPos': {
				jpn: '再生位置を変更しました: ',
				eng: 'Changed playback point.',
			},
			'alterRange': {
				jpn: '選択範囲を調整しました: ',
				eng: 'Region adjusted: ',
			},
			'setPos': {
				jpn: '再生位置を設定しました: ',
				eng: 'Playback point set: ',
			},
			'inPause': {
				jpn: '（停止中）',
				eng: '(Pause)',
			},
			'setRange': {
				jpn: '範囲を選択しました: ',
				eng: 'Region selected.: ',
			},
			'recording1': {
				jpn: '● 録音中... （離すと分析）',
				eng: '● Recording...  Release the button to analyse.',
			},
			'statusRecording': {
				jpn: '録音中... ボタンを離すと分析します。',
				eng: 'Recording...  Release the button to analyse.',
			},
			'micAccessError': {
				jpn: 'マイクにアクセスできませんでした。',
				eng: 'Could not access mic.',
			},
			'noRecData': {
				jpn: '録音データがありません。',
				eng: 'No Recording data.',
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
				eng: 'Analysing mic. recording.',
			},
			'finishMicAanalysing': {
				jpn: 'マイク録音の分析完了 ',
				eng: 'Finish Analysing mic. recording.',
			},
			'analysingRecError': {
				jpn: 'マイク録音の分析に失敗しました。',
				eng: 'Failed to analyse the mic. recording.',
			},
			'pauseMicRec': {
				jpn: 'マイク録音 停止',
				eng: 'Recording Stop',
			},
			'writingWebM': {
				jpn: 'WebMの書き出し中... （音声の実時間分だけ待ちます）',
				eng: 'Creating WebM file... (It takes as long as the audio duration.)',
			},
			'finishWritingWebM': {
				jpn: 'WebMの書き出しが完了しました。',
				eng: 'Finish writing WebM file.',
			},
			'writeSoundError': {
				jpn: '音声の書き出しに失敗しました: ',
				eng: 'Audio output failed: ',
			},
			'WebMnotSupported': {
				jpn: 'このブラウザはWebM出力に対応していません。Shiftキーを離してWAV出力をお試しください。',
				eng: 'This browser does not support WebM output.',
			},
			'mediaRecError': {
				jpn: 'MediaRecorderでエラーが発生しました。',
				eng: 'MediaRecorder error. ',
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
