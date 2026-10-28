import { useCallback, useEffect, useRef, useState } from 'react';
import { networkSample, videoBudget } from './video-quality';

export function useVideoCall({ state, ready, configuration, sendSignal, onMediaEnded, sharedStream = null, batchIce = false, peerCount = 1, getIceConfiguration, mediaAllowed = true }) {
    const [localStream, setLocalStream] = useState(null);
    const [remoteStream, setRemoteStream] = useState(null);
    const [status, setStatus] = useState('idle');
    const [error, setError] = useState('');
    const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
    const [cameraEnabled, setCameraEnabled] = useState(true);
    const [retryVersion, setRetryVersion] = useState(0);
    const [facingMode, setFacingMode] = useState('user');
    const [switchingCamera, setSwitchingCamera] = useState(false);
    const cameraSwitchPending = useRef(false);
    const streamRef = useRef(null);
    const mediaEpoch = useRef(0);
    const acquiring = useRef(null);
    const receiver = useRef(null);
    const closePeer = useRef(() => {});
    const recoverPeer = useRef(() => {});
    const suspendPeer = useCallback(() => closePeer.current(), []);
    const latest = useRef({ sendSignal, onMediaEnded, ready, configuration, getIceConfiguration, peerCount, group: state.mode === 'group' });
    latest.current = { sendSignal, onMediaEnded, ready, configuration, getIceConfiguration, peerCount, group: state.mode === 'group' };
    const mediaStream = sharedStream || localStream;

    const releaseMedia = useCallback(() => {
        mediaEpoch.current++;
        closePeer.current();
        for (const track of streamRef.current?.getTracks() || []) {
            track.onended = null;
            track.stop();
        }
        streamRef.current = null;
        setLocalStream(null);
        setRemoteStream(null);
        setStatus('idle');
        setMicrophoneEnabled(true);
        setCameraEnabled(true);
    }, []);

    const enableMedia = useCallback(async (options = {}) => {
        if (streamRef.current?.getTracks().every(track => track.readyState === 'live')) return streamRef.current;
        if (acquiring.current) return acquiring.current;
        const epoch = ++mediaEpoch.current;
        setError('');
        setStatus('requesting');
        const pending = (async () => {
            try {
                if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
                    throw new Error('A secure HTTPS connection or localhost is required for the camera and microphone.');
                }
                const group = options.group ?? latest.current.group;
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: group ? 640 : 1280, max: 1280 }, height: { ideal: group ? 360 : 720, max: 720 }, frameRate: { ideal: group ? 20 : 24, max: 30 }, facingMode: 'user' },
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                });
                if (epoch !== mediaEpoch.current) { stream.getTracks().forEach(track => track.stop()); return null; }
                streamRef.current = stream;
                for (const track of stream.getTracks()) {
                    track.onended = () => {
                        releaseMedia();
                        setError('Your camera or microphone stopped. Enable them again to start a video chat.');
                        latest.current.onMediaEnded?.();
                    };
                }
                setLocalStream(stream);
                setFacingMode(stream.getVideoTracks()[0]?.getSettings().facingMode || 'user');
                setMicrophoneEnabled(true);
                setCameraEnabled(true);
                setStatus('waiting');
                return stream;
            } catch (failure) {
                if (epoch !== mediaEpoch.current) return null;
                const message = failure.name === 'NotAllowedError' ? 'Camera and microphone permission was denied. Allow access in your browser to start video chat.'
                    : failure.name === 'NotFoundError' ? 'A camera and microphone are required for video chat.'
                    : failure.name === 'NotReadableError' ? 'Your camera or microphone is busy. Close other apps using it and try again.'
                    : failure.message || 'Unable to access the camera and microphone.';
                setError(message);
                setStatus('idle');
                return null;
            }
        })();
        acquiring.current = pending;
        try { return await pending; } finally { if (acquiring.current === pending) acquiring.current = null; }
    }, [releaseMedia]);

    useEffect(() => {
        if (!mediaStream || state.mode !== 'video' || state.status !== 'connected' || !mediaAllowed) {
            setRemoteStream(null);
            if (mediaStream) setStatus(ready ? 'waiting' : 'reconnecting');
            return;
        }
        const call = {
            room: state.room, instance: crypto.randomUUID(), peerInstance: null, sequence: 0,
            abort: new AbortController(),
            round: null, pc: null, closed: false, pending: 0, outgoing: Promise.resolve(), incoming: Promise.resolve(),
            localCandidates: [], earlyCandidates: new Map(), localDescriptionSent: false,
            attempts: 0, recovering: false, retired: new Set(), offerRevision: 0, ice: configuration, statsBusy: false, stableTimer: null, makingOffer: false, quality: null, healthySamples: 0, samples: new Map(),
            offer: null, answer: null, lastOffer: 0, timeout: null, disconnectTimeout: null, iceTimer: null, retryTimer: null, peerRevision: 0,
        };
        const recovery = latest.current.configuration?.recovery || {};
        const disconnectGraceMs = recovery.disconnectGraceMs || 4000;
        const connectTimeoutMs = (batchIce ? recovery.groupConnectTimeoutMs : recovery.connectTimeoutMs) || (batchIce ? 60000 : 30000);
        const attemptTimeoutMs = recovery.attemptTimeoutMs || 15000;
        const maxAttempts = recovery.maxAttempts || 3;
        const backoffMs = recovery.backoffMs?.length ? recovery.backoffMs : [1000, 3000, 7000];
        const replaceCamera = event => {
            const sender = call.pc?.getSenders().find(sender => sender.track?.kind === 'video');
            if (sender) event.detail.pending.push(sender.replaceTrack(event.detail.track));
        };
        mediaStream.addEventListener('camera-switch', replaceCamera);
        const active = pc => !call.closed && call.pc === pc;
        const healthy = pc => pc && pc.connectionState === 'connected' && !['failed', 'disconnected'].includes(pc.iceConnectionState);
        const fail = () => {
            if (call.closed || call.retryTimer || call.recovering) return;
            clearTimeout(call.stableTimer);
            setStatus('reconnecting');
            if (!navigator.onLine || !latest.current.ready) return;
            if (call.attempts >= maxAttempts) {
                setStatus('failed');
                setError('Video could not reconnect. Check your connection, then use Reconnect video.');
                return;
            }
            call.retryTimer = setTimeout(async () => {
                call.retryTimer = null;
                if (call.closed || !navigator.onLine || !latest.current.ready) return;
                call.recovering = true;
                call.attempts++;
                try {
                    if (state.initiator) await offer(true);
                    else await send('restart');
                } catch { /* The next bounded attempt handles failed signaling or ICE retrieval. */ }
                finally {
                    call.recovering = false;
                    if (!call.closed) {
                        clearTimeout(call.timeout);
                        call.timeout = setTimeout(() => { if (!healthy(call.pc)) fail(); }, attemptTimeoutMs);
                    }
                }
            }, backoffMs[Math.min(call.attempts, backoffMs.length - 1)]);
        };
        recoverPeer.current = () => {
            if (call.closed) return;
            if (call.pc && !healthy(call.pc)) fail();
            if (latest.current.ready && navigator.onLine) void readySignal().catch(() => {});
        };
        const offline = () => {
            clearTimeout(call.retryTimer); call.retryTimer = null;
            if (!healthy(call.pc)) setStatus('reconnecting');
        };
        const online = () => recoverPeer.current();
        window.addEventListener('offline', offline);
        window.addEventListener('online', online);
        async function refreshIce() {
            const value = latest.current.getIceConfiguration ? await latest.current.getIceConfiguration(call.abort.signal) : latest.current.configuration;
            if (call.closed) return false;
            call.ice = value;
            if (call.pc) call.pc.setConfiguration({ ...call.pc.getConfiguration(), iceServers: value?.iceServers || [], iceTransportPolicy: value?.iceTransportPolicy || 'all' });
            return true;
        }
        async function adaptQuality() {
            const pc = call.pc;
            if (!active(pc) || !healthy(pc) || call.statsBusy) return;
            call.statsBusy = true;
            try {
                const sample = networkSample(await pc.getStats(), call.samples);
                if (!active(pc)) return;
                call.samples = sample.previous;
                const device = navigator.connection;
                const constrained = !!device?.saveData || /(^|-)2g$/.test(device?.effectiveType || '') || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
                const budget = videoBudget({ group: batchIce, peers: latest.current.peerCount, constrained, ...sample });
                const sender = pc.getSenders().find(sender => sender.track?.kind === 'video');
                if (!sender) return;
                if (call.quality && budget.maxBitrate > call.quality.maxBitrate && ++call.healthySamples < 3) return;
                call.healthySamples = 0;
                if (JSON.stringify(budget) === JSON.stringify(call.quality)) return;
                const parameters = sender.getParameters();
                if (!parameters.encodings?.length) return;
                for (const encoding of parameters.encodings) Object.assign(encoding, budget);
                parameters.degradationPreference = 'maintain-framerate';
                await sender.setParameters(parameters);
                if (active(pc)) call.quality = budget;
            } catch { /* Browsers may not support all sender parameters. Native congestion control remains active. */ }
            finally { call.statsBusy = false; }
        }
        function destroyPeer() {
            clearTimeout(call.timeout);
            clearTimeout(call.stableTimer);
            clearTimeout(call.disconnectTimeout);
            clearTimeout(call.iceTimer);
            clearTimeout(call.retryTimer);
            call.retryTimer = null;
            call.iceTimer = null;
            if (call.pc) {
                call.pc.ontrack = null;
                call.pc.onicecandidate = null;
                call.pc.onconnectionstatechange = null;
                call.pc.oniceconnectionstatechange = null;
                call.pc.getReceivers().forEach(receiver => receiver.track?.stop());
                call.pc.close();
            }
            call.pc = null;
            call.samples.clear(); call.quality = null;
            setRemoteStream(null);
        }
        function send(kind, payload = null, negotiation = call.round || crypto.randomUUID()) {
            const packet = { room: call.room, kind, instance: call.instance, sequence: ++call.sequence, negotiation, payload };
            call.pending++;
            const request = call.outgoing.then(async () => {
                if (!call.closed && navigator.onLine && latest.current.ready) await latest.current.sendSignal(packet, call.abort.signal);
            }).finally(() => { call.pending--; });
            call.outgoing = request.catch(() => { if (!call.closed) fail(); });
            return request;
        }
        function readySignal() { return send('ready'); }
        function peer(round) {
            destroyPeer();
            call.round = round;
            call.localCandidates = [];
            call.localDescriptionSent = false;
            call.answer = null;
            const pc = new RTCPeerConnection({
                iceServers: call.ice?.iceServers || [],
                iceTransportPolicy: call.ice?.iceTransportPolicy || 'all',
            });
            call.pc = pc;
            setStatus('connecting');
            setError('');
            const remote = new MediaStream();
            pc.ontrack = event => {
                if (!active(pc)) return;
                if (!remote.getTracks().some(track => track.id === event.track.id)) remote.addTrack(event.track);
                setRemoteStream(remote);
            };
            pc.onicecandidate = event => {
                if (!active(pc) || !event.candidate) return;
                const candidate = event.candidate.toJSON();
                // Ignore a late candidate from an ICE generation already replaced.
                if (candidate.usernameFragment && pc.localDescription?.sdp && !pc.localDescription.sdp.includes('a=ice-ufrag:' + candidate.usernameFragment)) return;
                if (batchIce) {
                    call.localCandidates.push(candidate);
                    if (call.localDescriptionSent && !call.iceTimer) call.iceTimer = setTimeout(() => {
                        call.iceTimer = null;
                        flushLocal(pc);
                    }, 100);
                } else if (call.localDescriptionSent) void send('ice', candidate, call.round).catch(() => {});
                else call.localCandidates.push(candidate);
            };
            pc.onconnectionstatechange = () => {
                if (!active(pc)) return;
                if (healthy(pc)) {
                    clearTimeout(call.retryTimer);
                    call.retryTimer = null;
                    clearTimeout(call.timeout);
                    clearTimeout(call.disconnectTimeout);
                    clearTimeout(call.stableTimer);
                    call.stableTimer = setTimeout(() => { if (active(pc) && healthy(pc)) call.attempts = 0; }, 30000);
                    setStatus('connected');
                    setError('');
                    void adaptQuality();
                } else if (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected') {
                    if (!call.disconnectTimeout) {
                        setStatus('interrupted');
                        call.disconnectTimeout = setTimeout(() => { if (active(pc) && !healthy(pc)) fail(); }, disconnectGraceMs);
                    }
                } else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') fail();
            };
            pc.oniceconnectionstatechange = pc.onconnectionstatechange;
            for (const track of mediaStream.getTracks()) pc.addTrack(track, mediaStream);
            call.timeout = setTimeout(() => { if (active(pc) && pc.connectionState !== 'connected') fail(); }, connectTimeoutMs);
            void adaptQuality();
            return pc;
        }
        function flushLocal(pc) {
            if (!active(pc)) return;
            call.localDescriptionSent = true;
            const candidates = call.localCandidates.splice(0);
            if (batchIce) {
                for (let i = 0; i < candidates.length; i += 10) void send('ice-batch', { candidates: candidates.slice(i, i + 10) }).catch(() => {});
            } else for (const candidate of candidates) void send('ice', candidate).catch(() => {});
        }
        async function flushRemote(pc) {
            const round = call.round;
            const candidates = call.earlyCandidates.get(round) || [];
            call.earlyCandidates.delete(round);
            for (const candidate of candidates) { if (active(pc) && call.round === round) await pc.addIceCandidate(candidate); }
        }
        async function offer(restart = false) {
            if (call.makingOffer) return;
            call.makingOffer = true;
            try {
                if (call.closed || !latest.current.ready || !navigator.onLine) return;
                if (!await refreshIce()) return;
                let pc = call.pc;
                if (!pc || pc.signalingState === 'closed') pc = peer(crypto.randomUUID());
                else {
                    if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' });
                    call.retired.add(call.round);
                    call.round = crypto.randomUUID();
                    call.localCandidates = [];
                    call.localDescriptionSent = false;
                }
                if (!active(pc)) return;
                if (restart) { pc.restartIce?.(); setStatus('reconnecting'); }
                const description = await pc.createOffer({ iceRestart: restart });
                if (!active(pc)) return;
                await pc.setLocalDescription(description);
                if (!active(pc)) return;
                call.offer = { sdp: pc.localDescription.sdp };
                call.lastOffer = Date.now();
                void send('offer', call.offer).catch(() => {});
                flushLocal(pc);
            } finally { call.makingOffer = false; }
        }
        async function receive(packet) {
            if (call.closed || packet.room !== call.room || packet.instance === call.instance) return;
            if (packet.kind === 'ready') {
                if ((packet.revision || 0) < call.peerRevision) return;
                call.peerRevision = packet.revision || 0;
                if (call.peerInstance !== packet.instance) {
                    call.peerInstance = packet.instance;
                    call.earlyCandidates.clear();
                    destroyPeer();
                    call.round = null;
                    void readySignal().catch(() => {});
                    if (state.initiator) await offer();
                } else if (state.initiator && !call.pc) await offer();
                else if (state.initiator && call.pc.signalingState === 'have-local-offer' && call.pending === 0 && Date.now() - call.lastOffer > 4000) {
                    call.lastOffer = Date.now();
                    void send('offer', call.offer).catch(() => {});
                }
                return;
            }
            if (packet.instance !== call.peerInstance) return;
            if (packet.kind === 'restart') { if (state.initiator) fail(); return; }
            if (call.retired.has(packet.negotiation)) return;
            if (packet.kind === 'offer' && !state.initiator) {
                if (call.round === packet.negotiation && call.answer) { void send('answer', call.answer).catch(() => {}); flushLocal(call.pc); return; }
                if ((packet.revision || 0) < call.offerRevision) return;
                call.offerRevision = packet.revision || 0;
                if (!await refreshIce()) return;
                let pc = call.pc;
                if (!pc || pc.signalingState === 'closed') pc = peer(packet.negotiation);
                else {
                    call.retired.add(call.round);
                    call.round = packet.negotiation;
                    call.localCandidates = [];
                    call.localDescriptionSent = false;
                    setStatus('reconnecting');
                }
                await pc.setRemoteDescription({ type: 'offer', sdp: packet.payload.sdp });
                await flushRemote(pc);
                if (!active(pc)) return;
                await pc.setLocalDescription(await pc.createAnswer());
                if (!active(pc)) return;
                call.answer = { sdp: pc.localDescription.sdp };
                void send('answer', call.answer).catch(() => {});
                flushLocal(pc);
                pc.onconnectionstatechange?.();
            } else if (packet.kind === 'answer' && state.initiator && packet.negotiation === call.round && call.pc?.signalingState === 'have-local-offer') {
                const pc = call.pc;
                await pc.setRemoteDescription({ type: 'answer', sdp: packet.payload.sdp });
                await flushRemote(pc);
                pc.onconnectionstatechange?.();
            } else if (packet.kind === 'ice' || packet.kind === 'ice-batch') {
                for (const candidate of packet.kind === 'ice-batch' ? packet.payload.candidates : [packet.payload]) {
                    if (packet.negotiation === call.round && call.pc?.remoteDescription) await call.pc.addIceCandidate(candidate);
                    else if (!call.retired.has(packet.negotiation)) {
                        if (call.earlyCandidates.size > 2) call.earlyCandidates.clear();
                        const queue = call.earlyCandidates.get(packet.negotiation) || [];
                        if (queue.length < 100) queue.push(candidate);
                        call.earlyCandidates.set(packet.negotiation, queue);
                    }
                }
            }
        }
        receiver.current = packet => {
            call.incoming = call.incoming.then(() => receive(packet)).catch(() => { if (!call.closed) fail(); });
        };
        // Synchronous controls must invalidate queued signaling as well as close RTP.
        closePeer.current = () => {
            call.closed = true;
            call.abort.abort();
            clearInterval(timer);
            clearInterval(statsTimer);
            clearInterval(credentialTimer);
            window.removeEventListener('offline', offline);
            window.removeEventListener('online', online);
            mediaStream.removeEventListener('camera-switch', replaceCamera);
            recoverPeer.current = () => {};
            receiver.current = null;
            destroyPeer();
        };
        setStatus('connecting');
        void readySignal().catch(() => {});
        const statsTimer = setInterval(() => { void adaptQuality(); }, 8000);
        const credentialTimer = setInterval(async () => {
            if (call.closed || call.recovering || !latest.current.ready || !navigator.onLine || !call.ice?.expiresAt || call.ice.expiresAt * 1000 > Date.now() + 120000) return;
            call.recovering = true;
            try {
                if (state.initiator) await offer(true);
                else await refreshIce();
            } catch { fail(); }
            finally { call.recovering = false; }
        }, 60000);
        const timer = setInterval(() => {
            if (!call.closed && navigator.onLine && latest.current.ready && call.attempts < maxAttempts && !healthy(call.pc) && call.pending === 0) void readySignal().catch(() => {});
        }, 5000);
        return () => {
            call.closed = true;
            call.abort.abort();
            clearInterval(timer);
            destroyPeer();
            clearInterval(statsTimer);
            clearInterval(credentialTimer);
            window.removeEventListener('offline', offline);
            window.removeEventListener('online', online);
            mediaStream.removeEventListener('camera-switch', replaceCamera);
            recoverPeer.current = () => {};
            receiver.current = null;
            closePeer.current = () => {};
        };
    }, [state.room, state.status, state.mode, state.initiator, mediaStream, retryVersion, mediaAllowed]);

    useEffect(() => { if (ready) recoverPeer.current(); }, [ready]);

    useEffect(() => {
        const leaving = () => releaseMedia();
        window.addEventListener('pagehide', leaving);
        return () => {
            window.removeEventListener('pagehide', leaving);
            mediaEpoch.current++;
            closePeer.current();
            streamRef.current?.getTracks().forEach(track => track.stop());
        };
    }, [releaseMedia]);
    const receiveSignal = useCallback(packet => receiver.current?.(packet), []);
    function toggleMicrophone() {
        const enabled = !microphoneEnabled;
        streamRef.current?.getAudioTracks().forEach(track => { track.enabled = enabled; });
        setMicrophoneEnabled(enabled);
    }
    function toggleCamera() {
        const enabled = !cameraEnabled;
        streamRef.current?.getVideoTracks().forEach(track => { track.enabled = enabled; });
        setCameraEnabled(enabled);
    }
    async function switchCamera() {
        const stream = streamRef.current;
        const previous = stream?.getVideoTracks()[0];
        if (!previous || cameraSwitchPending.current) return;
        cameraSwitchPending.current = true;
        setSwitchingCamera(true);
        setError('');
        const epoch = mediaEpoch.current;
        const target = facingMode === 'environment' ? 'user' : 'environment';
        let replacement;
        try {
            const captured = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { exact: target }, width: { ideal: latest.current.group ? 640 : 1280, max: 1280 }, height: { ideal: latest.current.group ? 360 : 720, max: 720 }, frameRate: { ideal: 24, max: 30 } }, audio: false,
            });
            replacement = captured.getVideoTracks()[0];
            if (epoch !== mediaEpoch.current || stream !== streamRef.current) { replacement.stop(); return; }
            replacement.enabled = previous.enabled;
            const detail = { track: replacement, pending: [] };
            stream.dispatchEvent(new CustomEvent('camera-switch', { detail }));
            try { await Promise.all(detail.pending); }
            catch (failure) {
                const rollback = { track: previous, pending: [] };
                stream.dispatchEvent(new CustomEvent('camera-switch', { detail: rollback }));
                await Promise.allSettled(rollback.pending);
                throw failure;
            }
            if (epoch !== mediaEpoch.current) { replacement.stop(); return; }
            replacement.onended = previous.onended;
            previous.onended = null;
            stream.removeTrack(previous);
            stream.addTrack(replacement);
            previous.stop();
            setFacingMode(target);
        } catch (failure) {
            replacement?.stop();
            if (epoch === mediaEpoch.current) setError('Unable to switch cameras. Check that a front and back camera are available and not in use by another app.');
        } finally {
            cameraSwitchPending.current = false;
            setSwitchingCamera(false);
        }
    }
    return { localStream, remoteStream, status, error, facingMode, switchingCamera, switchCamera, enableMedia, releaseMedia, suspendPeer, receiveSignal, microphoneEnabled, cameraEnabled, toggleMicrophone, toggleCamera, retry: () => setRetryVersion(version => version + 1) };
}
