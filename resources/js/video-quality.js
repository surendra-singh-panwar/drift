// Modest per-edge budgets keep an eight-person mesh from uploading seven HD streams.
export function videoBudget({ group = false, peers = 1, constrained = false, loss = 0, rtt = 0, available = Infinity } = {}) {
    const count = Math.max(1, peers);
    const poor = constrained || loss > .08 || rtt > .6 || available < 180_000;
    const fair = loss > .025 || rtt > .3 || available < 450_000;
    if (group) return { maxBitrate: poor ? 120_000 : fair ? 220_000 : Math.min(600_000, Math.floor(1_800_000 / count)),
        maxFramerate: poor ? 12 : fair ? 15 : 20, scaleResolutionDownBy: poor ? 4 : fair || count >= 4 ? 2 : 1 };
    return { maxBitrate: poor ? 180_000 : fair ? 500_000 : 1_500_000,
        maxFramerate: poor ? 12 : fair ? 20 : 24, scaleResolutionDownBy: poor ? 4 : fair ? 2 : 1 };
}

export function networkSample(reports, previous = new Map()) {
    let lost = 0, rtt = 0, available = Infinity;
    const next = new Map();
    reports.forEach(report => {
        if (report.type === 'remote-inbound-rtp' && (report.kind || report.mediaType) === 'video') {
            if (Number.isFinite(report.fractionLost)) lost = Math.max(lost, report.fractionLost);
            rtt = Math.max(rtt, report.roundTripTime || 0);
        }
        if (report.type === 'inbound-rtp') {
            const old = previous.get(report.id);
            next.set(report.id, { lost: report.packetsLost || 0, received: report.packetsReceived || 0 });
            if (old) { lost = Math.max(lost, Math.max(0, (report.packetsLost || 0) - old.lost) / Math.max(1, (report.packetsReceived || 0) - old.received + (report.packetsLost || 0) - old.lost)); }
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
            rtt = Math.max(rtt, report.currentRoundTripTime || 0);
            if (report.availableOutgoingBitrate > 0) available = Math.min(available, report.availableOutgoingBitrate);
        }
    });
    return { loss: lost, rtt, available, previous: next };
}
