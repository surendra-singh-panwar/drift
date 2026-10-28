import React, { memo, useEffect } from 'react';
import { Camera } from './VideoPanel';
import { useVideoCall } from './use-video-call';

const statusLabels = { connecting: 'Connecting...', connected: 'Connected', interrupted: 'Connection interrupted', reconnecting: 'Reconnecting...', failed: 'Connection failed' };

const GroupPeer = memo(function GroupPeer({ peer, state, stream, ready, configuration, getIceConfiguration, mediaAllowed, sendSignal, registry, safety }) {
    const call = useVideoCall({
        state: { status: state.status, room: state.room, mode: 'video', initiator: state.self > peer },
        ready, configuration, getIceConfiguration, mediaAllowed, sharedStream: stream, batchIce: true, peerCount: Math.max(1, state.members.length - 1),
        sendSignal: (packet, signal) => sendSignal({ ...packet, to: peer, membership: state.epochs[state.self], targetMembership: state.epochs[peer] }, signal),
    });
    useEffect(() => {
        const handler = { receive: call.receiveSignal, close: call.suspendPeer };
        registry.current.set(peer, handler);
        return () => { if (registry.current.get(peer) === handler) registry.current.delete(peer); };
    }, [peer, call.receiveSignal, call.suspendPeer, registry]);
    return <div className="group-participant" data-peer={peer}>
        <Camera stream={call.remoteStream} label={`Participant ${peer.slice(0, 6)} camera`} />
        <div className="group-peer-status">Participant {peer.slice(0, 6)} · {statusLabels[call.status] || call.status}</div>
        {call.error && <p role="alert" className="error">{call.error}</p>}
        <div className="group-safety">
            {call.status === 'failed' && <button type="button" className="secondary" disabled={!ready} onClick={call.retry}>Reconnect participant</button>}
            <button type="button" className="secondary" onClick={() => safety('report', peer)}>Report</button>
            <button type="button" className="secondary" onClick={() => safety('block', peer)}>Block and leave</button>
        </div>
    </div>;
}, (previous, next) => previous.peer === next.peer && previous.stream === next.stream && previous.ready === next.ready
    && previous.mediaAllowed === next.mediaAllowed && previous.configuration === next.configuration && previous.state.room === next.state.room
    && previous.state.status === next.state.status && previous.state.self === next.state.self
    && previous.state.members.length === next.state.members.length
    && previous.state.epochs[previous.state.self] === next.state.epochs[next.state.self]
    && previous.state.epochs[previous.peer] === next.state.epochs[next.peer]);

export function GroupVideoPanel({ call, state, ready, busy, configuration, getIceConfiguration, mediaAllowed, sendSignal, registry, safety, suspended }) {
    const peers = suspended || state.status === 'idle' ? [] : (state.members || []).filter(id => id !== state.self);
    return <section className="video-panel group-video-panel" aria-label="Group video call">
        <div className="group-heading"><h3>Group video chat</h3><span>{state.members?.length || 0}/8 participants</span></div>
        <div className="group-video-grid">
            <div className="group-participant"><Camera stream={call.localStream} local label="Your camera" /><div className="group-peer-status">You · {call.localStream ? 'Camera ready' : 'Camera off'}</div></div>
            {peers.map(peer => <GroupPeer key={`${state.room}:${state.epochs?.[state.self]}:${peer}:${state.epochs?.[peer]}`} peer={peer} state={state} stream={call.localStream} ready={ready} configuration={configuration} getIceConfiguration={getIceConfiguration} mediaAllowed={mediaAllowed} sendSignal={sendSignal} registry={registry} safety={safety} />)}
        </div>
        <p className="video-status" role="status">{state.status === 'idle' ? 'Start to join a random group of up to eight people.' : peers.length ? (ready ? 'Connect with your group. New participants can join available places.' : 'Reconnecting to your group…') : 'Waiting for participants…'}</p>
        {!call.localStream && <p className="video-consent">Your camera and microphone are shared with up to seven other participants. Drift does not record calls.</p>}
        {!call.localStream && state.status === 'connected' && <button type="button" className="primary" disabled={!ready || busy} onClick={call.enableMedia}>Enable camera and microphone</button>}
        {call.localStream && <div className="video-controls">
            <button type="button" className="secondary" aria-pressed={!call.microphoneEnabled} onClick={call.toggleMicrophone}>{call.microphoneEnabled ? 'Mute microphone' : 'Unmute microphone'}</button>
            <button type="button" className="secondary" disabled={call.switchingCamera} onClick={call.switchCamera}>{call.switchingCamera ? 'Switching camera...' : call.facingMode === 'environment' ? 'Use front camera' : 'Use back camera'}</button>
            <button type="button" className="secondary" aria-pressed={!call.cameraEnabled} onClick={call.toggleCamera}>{call.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}</button>
        </div>}
        {call.error && <p role="alert" className="error">{call.error}</p>}
    </section>;
}
