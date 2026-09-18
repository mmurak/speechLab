// ============================================================
// RaptPitchTracker
//
// Talkin (1995) の RAPT を、SPTK3.11に収録された本家ソースコード
// (sigproc.c / jkGetF0.c, (c) 1990-1996 Entropic Research Laboratory,
// Written by David Talkin, Derek Lin)に基づき、できる限り忠実に
// JavaScriptへ移植したもの。以下、本家の数式通りに実装している:
//
// ・NCCF(正規化相互相関)は固定長の窓(wind_dur)を使い、ラグが伸びても
//	 窓の重なりを縮めない(エネルギーは差分更新で高速に計算)
// ・粗探索(約2kHzまでダウンサンプリング)→候補周辺だけフル解像度で
//	 精密化する2段階探索(crossf/crossfi, get_fast_cands相当)
// ・候補のしきい値(cand_thresh)はそのフレーム自身の最大相関値に対する
//	 相対値
// ・無声候補のコストは固定値ではなく voice_bias + そのフレームの最大相関値
// ・lag_weight は相関値への乗算(短い周期を優先)
// ・フレーム間の周波数連続性コストは freq_weight ベースだが、
//	 double_cost によってオクターブ差付近で伸びが頭打ちになる
// ・有声⇔無声の切り替えコストに使う定常性(sta)は、前後2つの窓に対する
//	 LPC分析(xlpc)とItakura距離(xitakura)による、本家と同じ計算式
//	 (get_similarity相当)。ストリーミング処理用の窓統計キャッシュは
//	 オフライン一括処理では不要なため省略している(結果は数学的に同じ)
//
// 【本家と異なる部分】
// ダウンサンプリング時のアンチエイリアシングフィルタは、原典の設計
// (Hanning窓sincによる可変長FIR)とは別に、固定31タップの窓付きsinc
// FIRローパスで代用している。また、crossfiの安定化定数(原典は10000.0)
// は、元コードが前提とする振幅スケール(16bit PCM相当)向けの値なので、
// -1〜1の浮動小数点信号に合わせて縮小してある。
// ============================================================
class RaptPitchTracker {
	constructor({
		fMin, fMax, sampleRate,
		frameStepSec = 0.01,	 // frame_step
		windDurSec = 0.0075,	 // wind_dur (NCCFの固定窓長)
		nCandsMax = 20,				// n_cands
		candThresh = 0.3,			// cand_thresh (そのフレームの最大相関に対する相対しきい値)
		lagWeight = 0.3,			 // lag_weight [0,1]
		freqWeight = 0.02,		 // freq_weight
		transCost = 0.005,		 // trans_cost
		transAmp = 0.5,				// trans_amp
		transSpec = 0.5,			 // trans_spec
		voiceBias = 0.0,			 // voice_bias [-1,1]
		doubleCost = 0.35			// double_cost
	}) {
		this.sampleRate = sampleRate;
		this.start = Math.round(sampleRate / fMax); // periodMin(短い周期側)
		this.stop = Math.round(sampleRate / fMin);	// periodMax(長い周期側)
		this.nlags = this.stop - this.start + 1;
		this.size = Math.max(8, Math.round(windDurSec * sampleRate)); // NCCFの固定参照窓長
		this.step = Math.max(1, Math.round(frameStepSec * sampleRate));
		this.frameStepSec = this.step / sampleRate;

		this.nCandsMax = nCandsMax;
		this.candThresh = candThresh;
		this.lagWeight = lagWeight;
		this.freqWeight = freqWeight;
		this.transCost = transCost;
		this.transAmp = transAmp;
		this.transSpec = transSpec;
		this.voiceBias = voiceBias;
		this.doubleCost = doubleCost;
		this.ln2 = Math.log(2);

		this.lagwt = lagWeight / this.stop;					 // DPのローカルコストで使う
		this.freqwt = freqWeight / this.frameStepSec; // フレーム間周波数変化のペナルティ係数

		// 粗探索は約2kHzまでダウンサンプリングする(本家に合わせた絶対値)
		this.decimate = Math.max(1, Math.round(sampleRate / 2000));

		// crossfiの安定化定数(原典は10000.0だが、これは元コードが前提とする
		// 振幅スケール(16bit PCM相当)向けの値なので、-1〜1の浮動小数点信号に
		// 合わせて縮小してある)
		this.ballast = 1e-6;

		// ---- 定常性測定(get_stationarity/get_similarity相当) ----
		// STAT_WSIZE: 定常性測定に使う窓の長さ(秒)
		// STAT_AINT : 前後の窓の中心間隔(秒)。窓長より短いので2窓は重なる
		const STAT_WSIZE = 0.030;
		const STAT_AINT = 0.020;
		this.statSize = Math.round(STAT_WSIZE * sampleRate);
		this.statAgap = Math.round(STAT_AINT * sampleRate);
		this.statInd = Math.trunc((this.statAgap - this.statSize) / 2);
		this.statOrder = Math.min(100, Math.round(2 + sampleRate / 1000)); // LPC次数
		this.statPreemp = 0.4;
		this.statStab = 30.0;
	}

	// ---- NCCF(固定長の参照窓、エネルギーは差分更新) ----
	// data の doff から始まる size サンプルを参照窓とし、
	// start 〜 start+nlags-1 の各ラグでの正規化相互相関を計算する
	crossf(data, doff, size, start, nlags) {
		const total = size + start + nlags;
		let mean = 0;
		for (let j = 0; j < size; j++) mean += data[doff + j];
		mean /= size;

		const db = new Float32Array(total);
		for (let j = 0; j < total; j++) db[j] = data[doff + j] - mean;

		let sum = 0;
		for (let j = 0; j < size; j++) sum += db[j] * db[j];
		const engref = sum; // 参照窓のエネルギー

		const correl = new Float32Array(nlags);
		let maxval = 0, maxloc = -1;

		if (engref > 0) {
			let engc = 0;
			for (let j = 0; j < size; j++) engc += db[start + j] * db[start + j];

			for (let i = 0; i < nlags; i++) {
				let s = 0;
				for (let j = 0; j < size; j++) s += db[j] * db[i + start + j];
				const denom = Math.sqrt(Math.max(engc, 1e-9) * engref);
				const t = s / denom;
				correl[i] = t;

				const leaving = db[i + start];
				const entering = db[i + start + size];
				engc -= leaving * leaving;
				engc += entering * entering;
				if (engc < 1e-9) engc = 1e-9;

				if (t > maxval) { maxval = t; maxloc = i + start; }
			}
		}
		return { engref, maxloc, maxval, correl };
	}

	// ---- パッチ版NCCF(候補周辺だけフル解像度で計算し直す) ----
	// locs で指定した各位置の周辺 patchNlags 個のラグだけを計算し、
	// それ以外は0のままにする(get_f0のcrossfi相当)
	crossfi(data, doff, size, start0, nlags0, patchNlags, locs) {
		const total = size + start0 + nlags0;
		let mean = 0;
		for (let j = 0; j < size; j++) mean += data[doff + j];
		mean /= size;

		const db = new Float32Array(total);
		for (let j = 0; j < total; j++) db[j] = data[doff + j] - mean;

		let sum = 0;
		for (let j = 0; j < size; j++) sum += db[j] * db[j];
		const engref = sum;

		const correl = new Float32Array(nlags0);
		let maxval = 0, maxloc = -1;

		if (engref > 0) {
			for (const loc of locs) {
				let start = loc - (patchNlags >> 1);
				if (start < start0) start = start0;
				let ci = start - start0;

				let engc = 0;
				for (let j = 0; j < size; j++) engc += db[start + j] * db[start + j];

				for (let i = 0; i < patchNlags; i++) {
					if (ci >= nlags0 || ci < 0) break;
					const base = i + start;
					if (base + size > total) break;
					let s = 0;
					for (let j = 0; j < size; j++) s += db[j] * db[base + j];
					const denom = Math.sqrt(this.ballast + Math.max(engc, 1e-9) * engref);
					const t = s / denom;
					correl[ci] = t;

					const leaving = db[base];
					const entering = db[base + size];
					engc -= leaving * leaving;
					engc += entering * entering;
					if (engc < 1e-9) engc = 1e-9;

					if (t > maxval) { maxval = t; maxloc = base; }
					ci++;
				}
			}
		}
		return { engref, maxloc, maxval, correl };
	}

	// 3点放物線補間で、局所ピークのサブサンプル位置と高さを求める
	parabolicPeak(y, idx) {
		const a = (y[idx + 1] - y[idx]) + 0.5 * (y[idx - 1] - y[idx + 1]);
		if (Math.abs(a) > 1e-6) {
			const xp = (y[idx - 1] - y[idx + 1]) / (4.0 * a);
			const yp = y[idx] - a * xp * xp;
			return { xp, yp };
		}
		return { xp: 0, yp: y[idx] };
	}

	// ---- 候補ピークの抽出(cand_thresh はそのフレーム自身の最大値に対する相対値) ----
	getCand(correl, maxval, candThresh) {
		const clip = candThresh * maxval;
		const candidates = [];
		if (correl.length < 3) return candidates;
		for (let i = 1; i < correl.length - 1; i++) {
			const o = correl[i - 1], q = correl[i], p = correl[i + 1];
			if (q > clip && q >= p && q >= o) {
				candidates.push({ idx: i, val: q });
			}
		}
		return candidates;
	}

	// ---- 2段階のピッチ候補探索(粗探索→フル解像度での精密化) ----
	getFastCands(fdata, dsData, frameStart) {
		const dec = this.decimate;
		const { start, nlags, size } = this;

		// 粗探索(ダウンサンプル済み信号上でNCCF)
		const decStart = Math.max(1, Math.floor(start / dec));
		const decSize = 1 + Math.floor(size / dec);
		const decNlags = Math.max(3, 1 + Math.floor(nlags / dec));
		const decFrameStart = Math.floor(frameStart / dec);

		const coarse = this.crossf(dsData, decFrameStart, decSize, decStart, decNlags);
		const coarsePeaks = this.getCand(coarse.correl, coarse.maxval, this.candThresh);

		const lagWtCoarse = this.lagWeight / nlags; // 粗探索での足切りにだけ使う暫定的な重み
		let refined = coarsePeaks.map(c => {
			const { xp, yp } = this.parabolicPeak(coarse.correl, c.idx);
			const locFull = Math.round((decStart + c.idx) * dec + xp * dec);
			return { loc: locFull, val: yp * (1 - lagWtCoarse * locFull) };
		});

		refined.sort((a, b) => b.val - a.val);
		if (refined.length > this.nCandsMax - 1) refined = refined.slice(0, this.nCandsMax - 1);
		if (refined.length === 0) return { candidates: [], maxval: 0, correl: null };

		// 精密化(候補周辺±3サンプルだけフル解像度で計算し直す)。
		// 本家はこの段階では補間せず、整数ラグのまま扱う
		// (サブサンプル補間はバックトラック時に勝ち残った候補だけに対して行う)
		const locs = refined.map(c => c.loc);
		const patch = this.crossfi(fdata, frameStart, size, start, nlags, 7, locs);
		const finePeaks = this.getCand(patch.correl, patch.maxval, this.candThresh);

		let finalCands = finePeaks.map(c => ({
			loc: start + c.idx,								 // 整数のまま(補間しない)
			val: Math.min(patch.correl[c.idx], 1) // 生の相関値(補間しない)
		}));

		finalCands.sort((a, b) => b.val - a.val);
		if (finalCands.length > this.nCandsMax - 1) finalCands = finalCands.slice(0, this.nCandsMax - 1);

		return { candidates: finalCands, maxval: patch.maxval, correl: patch.correl };
	}

	// ---- ダウンサンプリング(窓付きsincによるFIRローパス+間引き) ----
	designLowpassFIR(cutoffHz, sampleRate, numTaps) {
		const h = new Float32Array(numTaps);
		const fc = cutoffHz / sampleRate;
		const m = numTaps - 1;
		for (let n = 0; n < numTaps; n++) {
			const k = n - m / 2;
			const sinc = (k === 0) ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
			const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / m); // Hann窓
			h[n] = sinc * w;
		}
		let sum = 0;
		for (const v of h) sum += v;
		for (let n = 0; n < numTaps; n++) h[n] /= sum;
		return h;
	}

	applyFIR(signal, h) {
		const m = h.length;
		const half = Math.floor(m / 2);
		const out = new Float32Array(signal.length);
		for (let i = 0; i < signal.length; i++) {
			let sum = 0;
			for (let j = 0; j < m; j++) {
				const idx = i + j - half;
				if (idx >= 0 && idx < signal.length) sum += h[j] * signal[idx];
			}
			out[i] = sum;
		}
		return out;
	}

	downsample(signal, dec) {
		if (dec <= 1) return signal;
		const cutoff = this.sampleRate / (2 * dec); // ダウンサンプル後のナイキスト周波数ちょうど(原典のbeta=0.5/decimateに一致)
		let numTaps = Math.round(this.sampleRate * 0.005);
		numTaps |= 1; // 原典と同じく奇数に揃える
		const filter = this.designLowpassFIR(cutoff, this.sampleRate, numTaps);
		const filtered = this.applyFIR(signal, filter);
		const outLen = Math.floor(filtered.length / dec);
		const out = new Float32Array(outLen);
		for (let i = 0; i < outLen; i++) out[i] = filtered[i * dec];
		return out;
	}

	// ---- Hanning窓(原典xhnwindowと同じ、半サンプルずらした定義) ----
	hanningWindow(n) {
		const w = new Float64Array(n);
		const arg = (2 * Math.PI) / n;
		for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((i + 0.5) * arg);
		return w;
	}

	// プリエンファシス付きHanning窓を適用する(dinはwsize+1点必要)
	applyHanningPreemp(din, doff, wsize, preemp) {
		const w = this.hanningWindow(wsize);
		const dout = new Float64Array(wsize);
		for (let i = 0; i < wsize; i++) {
			const val = din[doff + i + 1] - preemp * din[doff + i];
			dout[i] = w[i] * val;
		}
		return dout;
	}

	// 正規化自己相関(r[0]=1)とRMSを求める(xautoc相当)
	xautoc(windowed, order) {
		const n = windowed.length;
		let sum0 = 0;
		for (let i = 0; i < n; i++) sum0 += windowed[i] * windowed[i];
		const r = new Float64Array(order + 1);
		r[0] = 1;
		if (sum0 === 0) return { r, rms: 1 };
		const rms = Math.sqrt(sum0 / n);
		const inv = 1 / sum0;
		for (let lag = 1; lag <= order; lag++) {
			let sum = 0;
			for (let i = 0; i < n - lag; i++) sum += windowed[i] * windowed[i + lag];
			r[lag] = sum * inv;
		}
		return { r, rms };
	}

	// Durbin再帰(xdurbin相当。aは1..order番目の係数、a[0]=1は暗黙で含まない)
	xdurbin(r, order) {
		const a = new Float64Array(order);
		let e = r[0];
		a[0] = -r[1] / e;
		e *= (1 - a[0] * a[0]);
		for (let i = 1; i < order; i++) {
			let s = 0;
			for (let j = 0; j < i; j++) s -= a[j] * r[i - j];
			const k = (s - r[i + 1]) / e;
			const prev = a.slice(0, i);
			for (let j = 0; j < i; j++) a[j] = prev[j] + k * prev[i - j - 1];
			a[i] = k;
			e *= (1 - k * k);
		}
		return { a, err: e };
	}

	// 自己相関法によるLPC分析(xlpc相当)。dataはdoffからsize+1点必要
	xlpc(data, doff, size, order, preemp, stab) {
		const wsize = size - 1;
		const windowed = this.applyHanningPreemp(data, doff, wsize, preemp);
		const { r, rms: rawRms } = this.xautoc(windowed, order);
		if (stab > 1.0) {
			const ffact = 1 / (1 + Math.exp((-stab / 20) * Math.log(10)));
			for (let i = 1; i <= order; i++) r[i] *= ffact;
		}
		const { a, err } = this.xdurbin(r, order);
		const wfact = 0.612372; // Hanning窓のRMS補正係数(原典のwfact, type=3相当)
		return { a, err: Math.max(err, 1e-9), rho: r, rms: rawRms / wfact };
	}

	// LPC係数の自己相関(xa_to_aca相当)
	xAtoAca(a, order) {
		let s = 1.0;
		for (let i = 0; i < order; i++) s += a[i] * a[i];
		const b0 = s;
		const b = new Float64Array(order);
		for (let i = 1; i <= order; i++) {
			let s2 = a[i - 1];
			for (let j = 0; j < order - i; j++) s2 += a[j] * a[j + i];
			b[i - 1] = 2 * s2;
		}
		return { b0, b };
	}

	// Itakura距離(xitakura相当)。1以上の値を返す
	xitakura(b0, b, rho, err, order) {
		let s = b0;
		for (let i = 0; i < order; i++) s += rho[i + 1] * b[i];
		return s / err;
	}

	// 窓形状のみ(プリエンファシスなし)でのRMS(wind_energy相当)
	windEnergy(data, doff, size) {
		const w = this.hanningWindow(size);
		let sum = 0;
		for (let i = 0; i < size; i++) {
			const v = w[i] * data[doff + i];
			sum += v * v;
		}
		return Math.sqrt(sum / size);
	}

	// 2つの窓(前フレーム/現フレーム)間のスペクトル類似度とRMS比を求める
	// (get_similarity相当。窓統計のキャッシュはオフライン処理では不要なため省略)
	getSimilarity(signal, pOff, cOff, size, order, preemp, stab, isFirst) {
		const cur = this.xlpc(signal, cOff, size, order, preemp, stab);
		const rms3 = this.windEnergy(signal, cOff, size);
		let rmsRatio, t;
		if (!isFirst) {
			const prev = this.xlpc(signal, pOff, size, order, preemp, stab);
			const rms1 = this.windEnergy(signal, pOff, size);
			const { b0, b } = this.xAtoAca(cur.a, order);
			t = this.xitakura(b0, b, prev.rho, prev.err, order) - 0.8;
			if (Math.abs(t) < 1e-6) t = t < 0 ? -1e-6 : 1e-6; // ゼロ除算を避ける
			rmsRatio = rms1 > 0 ? (0.001 + rms3) / rms1 : (rms3 > 0 ? 2.0 : 1.0);
		} else {
			rmsRatio = 1.0;
			t = 10.0;
		}
		return { sta: 0.2 / t, rmsRatio, rms: rms3 };
	}

	// 各DPフレームについて、定常性(sta)・RMSエネルギー比(rmsRatio)・
	// 音の強さ(rms)を求める。
	// 本家はストリーミング処理用の循環バッファ・窓統計キャッシュを使うが、
	// このアプリは録音全体を一括で扱うオフライン処理なので、
	// 前後の窓を毎回そのまま切り出して計算する(結果は数学的に同じ)
	computeStationarityAndEnergy(signal, frameStarts) {
		const { statSize: size, statAgap: agap, statInd: ind, statOrder: order, statPreemp: preemp, statStab: stab } = this;
		const n = frameStarts.length;
		const sta = new Float32Array(n);
		const rmsRatio = new Float32Array(n);
		const rms = new Float32Array(n);

		for (let t = 0; t < n; t++) {
			const qOff = frameStarts[t] + ind;
			const pOff = qOff - agap;
			const isFirst = t === 0;
			const inBounds = pOff >= 0 && qOff >= 0 &&
				(pOff + size + 1) <= signal.length && (qOff + size + 1) <= signal.length;

			if (inBounds) {
				const { sta: s, rmsRatio: r, rms: rv } = this.getSimilarity(signal, pOff, qOff, size, order, preemp, stab, isFirst);
				sta[t] = s;
				rmsRatio[t] = r;
				rms[t] = rv;
			} else {
				// 範囲外(録音の端など): 大きめの変化があったものとして扱う
				sta[t] = 0.02;
				rmsRatio[t] = 1.0;
				// 音の強さだけは、NCCFの窓を流用して直接計算しておく
				const fs = frameStarts[t];
				if (fs >= 0 && fs + this.size <= signal.length) {
					let sum = 0;
					for (let k = 0; k < this.size; k++) sum += signal[fs + k] * signal[fs + k];
					rms[t] = Math.sqrt(sum / this.size);
				} else {
					rms[t] = 0;
				}
			}
		}
		return { sta, rmsRatio, rms };
	}

	_localCost(c) {
		if (c.period === 0) return this.voiceBias + c.corr; // 無声候補: voice_bias + そのフレームの最大相関
		return 1 - c.corr * (1 - c.period * this.lagwt);		 // 有声候補: lag_weightを乗算で反映
	}

	// 有声⇔無声・フレーム間のコスト(本家の数式に準拠。sta/rmsRatioのみ近似)
	_transitionCost(prev, cur, sta_t, rmsRatio_t) {
		const prevVoiced = prev.period !== 0;
		const curVoiced = cur.period !== 0;
		if (!prevVoiced && !curVoiced) return 0;

		if (prevVoiced && curVoiced) {
			const ftemp = Math.log(cur.period / prev.period);
			let ttemp = Math.abs(ftemp);
			let ft1 = this.doubleCost + Math.abs(ftemp + this.ln2);
			if (ttemp > ft1) ttemp = ft1;
			ft1 = this.doubleCost + Math.abs(ftemp - this.ln2);
			if (ttemp > ft1) ttemp = ft1;
			return ttemp * this.freqwt;
		}
		if (!prevVoiced && curVoiced) {
			return this.transCost + this.transSpec * sta_t + this.transAmp / rmsRatio_t;
		}
		return this.transCost + this.transSpec * sta_t + this.transAmp * rmsRatio_t;
	}

	/**
	 * 音声信号全体を解析し、フレームごとの {time, fx, vs} の配列を返す。
	 * @param {Float32Array} signal モノラルの波形全体
	 * @returns {{time:number, fx:number, vs:number}[]}
	 */
	analyze(signal) {
		const { step, size, start, stop, nlags } = this;
		const ncomp = size + stop + 1; // 1フレームの解析に必要な全サンプル数
		const frameCount = Math.max(0, Math.floor((signal.length - ncomp) / step) + 1);
		if (frameCount <= 0) return [];

		const dsSignal = this.downsample(signal, this.decimate);

		const frameStarts = new Array(frameCount);
		for (let t = 0; t < frameCount; t++) frameStarts[t] = t * step;

		// 候補生成(2段階NCCF)
		const allCandidates = new Array(frameCount);
		const correlPerFrame = new Array(frameCount); // バックトラック時の最終補間に使う
		for (let t = 0; t < frameCount; t++) {
			const { candidates, maxval, correl } = this.getFastCands(signal, dsSignal, frameStarts[t]);
			const list = candidates.map(c => ({ period: c.loc, corr: c.val }));
			list.push({ period: 0, corr: maxval }); // 無声の仮想候補
			allCandidates[t] = list;
			correlPerFrame[t] = correl;
		}

		// 定常性・エネルギー比(有声⇔無声の切り替えコストに使う)
		const { sta, rmsRatio, rms } = this.computeStationarityAndEnergy(signal, frameStarts);

		// ---- 動的計画法(Viterbi) ----
		const dp = [allCandidates[0].map(c => this._localCost(c))];
		const backptr = [null];

		for (let t = 1; t < frameCount; t++) {
			const prevCands = allCandidates[t - 1];
			const curCands = allCandidates[t];
			const costs = new Array(curCands.length);
			const back = new Array(curCands.length);

			for (let k = 0; k < curCands.length; k++) {
				let best = Infinity, bestIdx = 0;
				for (let kp = 0; kp < prevCands.length; kp++) {
					const c = dp[t - 1][kp] + this._transitionCost(prevCands[kp], curCands[k], sta[t], rmsRatio[t]);
					if (c < best) { best = c; bestIdx = kp; }
				}
				costs[k] = best + this._localCost(curCands[k]);
				back[k] = bestIdx;
			}
			dp.push(costs);
			backptr.push(back);
		}

		const lastCosts = dp[dp.length - 1];
		let k = lastCosts.indexOf(Math.min(...lastCosts));
		const chosen = new Array(frameCount);
		for (let t = frameCount - 1; t >= 0; t--) {
			chosen[t] = allCandidates[t][k];
			if (t > 0) k = backptr[t][k];
		}

		// バックトラック後、勝ち残った候補についてだけサブサンプル補間を行う
		// (本家dp_f0()の出力ループにある専用の補間式。DPの候補選択自体には
		// 使われず、最終的な出力周波数の精度だけを上げるためのもの)
		return chosen.map((c, t) => {
			let fx = 0;
			if (c.period > 0) {
				let ftemp = c.period;
				const correl = correlPerFrame[t];
				if (correl && c.period > this.start && c.period < this.stop) {
					const j = c.period - this.start;
					const cormax = correl[j];
					const cprev = correl[j + 1];
					const cnext = correl[j - 1];
					const den = 2.0 * (cprev + cnext - 2.0 * cormax);
					if (Math.abs(den) > 0.000001) {
						ftemp += 2.0 - ((5.0 * cprev + 3.0 * cnext - 8.0 * cormax) / den);
					}
				}
				fx = this.sampleRate / ftemp;
			}
			return {
				time: (t * step) / this.sampleRate,
				fx,
				vs: c.corr,
				rms: rms[t]
			};
		});
	}
}
