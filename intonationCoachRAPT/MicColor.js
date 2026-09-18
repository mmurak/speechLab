class MicColor {
	static STOPS = [
		{ pos: 0.0, r: 255, g: 184, b: 77},
		{ pos: 0.50, r: 255, g: 221, b: 153},
		{ pos: 1.0,  r: 255, g: 255, b: 255},
	];
	getColor(t) {
		t = Math.max(0, Math.min(1, t));
		let idx = 0;
		while (idx < MicColor.STOPS.length - 2 && MicColor.STOPS[idx + 1].pos < t) {
			idx++;
		}

		const c1 = MicColor.STOPS[idx];
		const c2 = MicColor.STOPS[idx + 1];

		const segmentT = (t - c1.pos) / (c2.pos - c1.pos);

		const r = Math.round(c1.r + (c2.r - c1.r) * segmentT);
		const g = Math.round(c1.g + (c2.g - c1.g) * segmentT);
		const b = Math.round(c1.b + (c2.b - c1.b) * segmentT);

		return `rgb(${r}, ${g}, ${b})`;
	}
}
