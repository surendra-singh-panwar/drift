import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkSample, videoBudget } from '../../resources/js/video-quality.js';

test('eight-person mesh shares a bounded upload budget and lowers frame rate on poor links', () => {
    const normal = videoBudget({ group: true, peers: 7 });
    assert.ok(normal.maxBitrate * 7 <= 1_800_000);
    assert.equal(normal.scaleResolutionDownBy, 2);
    const poor = videoBudget({ group: true, peers: 7, loss: .12 });
    assert.ok(poor.maxBitrate < normal.maxBitrate);
    assert.ok(poor.maxFramerate < normal.maxFramerate);
    assert.equal(poor.scaleResolutionDownBy, 4);
    assert.deepEqual(videoBudget({ group: true, peers: 7, constrained: true }), poor);
});

test('single calls retain HD budget when healthy and reduce it on RTT or bandwidth pressure', () => {
    assert.equal(videoBudget().scaleResolutionDownBy, 1);
    assert.ok(videoBudget({ rtt: .7 }).maxBitrate < videoBudget().maxBitrate);
    assert.ok(videoBudget({ available: 100_000 }).maxFramerate <= 15);
});

test('statistics use interval packet loss and selected candidate RTT', () => {
    const previous = new Map([['video', { received: 1000, lost: 20 }]]);
    const sample = networkSample(new Map([
        ['video', { id: 'video', type: 'inbound-rtp', packetsReceived: 1090, packetsLost: 30 }],
        ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: .4, availableOutgoingBitrate: 400_000 }],
    ]), previous);
    assert.equal(sample.loss, .1);
    assert.equal(sample.rtt, .4);
    assert.equal(sample.available, 400_000);
    const recovered = networkSample(new Map([['video', { id: 'video', type: 'inbound-rtp', packetsReceived: 1190, packetsLost: 30 }]]), sample.previous);
    assert.equal(recovered.loss, 0);
});
