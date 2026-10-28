import React, { useEffect, useRef, useState } from 'react';

export function Camera({ stream, local, label }) {
    const video = useRef(null);
    const tile = useRef(null);
    const [zoom, setZoom] = useState(1);
    const [fill, setFill] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    useEffect(() => {
        const update = () => setIsFullscreen(document.fullscreenElement === tile.current);
        document.addEventListener('fullscreenchange', update);
        return () => document.removeEventListener('fullscreenchange', update);
    }, []);
    useEffect(() => {
        if (!expanded) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const escape = event => { if (event.key === 'Escape') setExpanded(false); };
        window.addEventListener('keydown', escape);
        return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', escape); };
    }, [expanded]);
    async function fullscreen() {
        try {
            if (document.fullscreenElement === tile.current) { await document.exitFullscreen(); return; }
            if (tile.current.requestFullscreen) await tile.current.requestFullscreen();
            else if (video.current.webkitEnterFullscreen) video.current.webkitEnterFullscreen();
            else setExpanded(true);
        } catch { setExpanded(true); }
    }
    const [playBlocked, setPlayBlocked] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const element = video.current;
        element.srcObject = stream;
        setPlayBlocked(false);
        if (stream) element.play().catch(() => { if (!cancelled) setPlayBlocked(true); });
        return () => { cancelled = true; element.srcObject = null; };
    }, [stream]);
    return <div ref={tile} className={`camera-tile ${expanded ? 'camera-expanded' : ''} ${local && stream?.getVideoTracks()[0]?.getSettings().facingMode !== 'environment' ? 'local-camera' : ''}`}>
        <video ref={video} aria-label={label} style={{ objectFit: fill ? 'cover' : 'contain', transform: `scale(${local && stream?.getVideoTracks()[0]?.getSettings().facingMode !== 'environment' ? -zoom : zoom}, ${zoom})` }} autoPlay playsInline muted={local} />
        {!stream && <span className="camera-placeholder">{local ? 'Your camera preview' : 'Waiting for stranger video'}</span>}
        <span className="camera-label">{local ? 'You' : label.replace(' camera', '')}</span>
        <div className="camera-tools" role="group" aria-label={label + ' view controls'}>
            <button type="button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .25))}>-</button>
            <button type="button" aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button type="button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))}>+</button>
            <button type="button" aria-pressed={fill} onClick={() => setFill(value => !value)}>{fill ? 'Fit' : 'Fill'}</button>
            <button type="button" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Close' : 'Expand'}</button>
            <button type="button" onClick={fullscreen}>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
        </div>
        {playBlocked && <button type="button" className="secondary video-play" onClick={() => video.current.play().then(() => setPlayBlocked(false)).catch(() => {})}>Play video and audio</button>}
    </div>;
}

export function VideoPanel({ call, state, ready, busy, resume }) {
    const labels = { idle: 'Camera and microphone are off', requesting: 'Requesting camera and microphone…', waiting: state.status === 'searching' ? 'Searching for a video partner…' : 'Camera preview ready', connecting: 'Connecting...', connected: 'Connected', interrupted: 'Connection interrupted', reconnecting: 'Reconnecting...', failed: 'Connection failed' };
    return <section className="video-panel" aria-label="Video call">
        <div className="video-grid">
            <Camera stream={call.remoteStream} label="Stranger camera" />
            <Camera stream={call.localStream} local label="Your camera" />
        </div>
        <div className="video-status" role="status">{labels[call.status]}</div>
        {!call.localStream && <p className="video-consent">Video chat shares your camera and microphone with your matched stranger. Media is not recorded by Drift.</p>}
        {!call.localStream && state.status === 'connected' && <button className="primary" disabled={!ready || busy || call.status === 'requesting'} onClick={resume}>Enable camera and microphone</button>}
        {call.localStream && <div className="video-controls">
            <button type="button" className="secondary" aria-pressed={!call.microphoneEnabled} onClick={call.toggleMicrophone}>{call.microphoneEnabled ? 'Mute microphone' : 'Unmute microphone'}</button>
            <button type="button" className="secondary" disabled={call.switchingCamera} onClick={call.switchCamera}>{call.switchingCamera ? 'Switching camera...' : call.facingMode === 'environment' ? 'Use front camera' : 'Use back camera'}</button>
            <button type="button" className="secondary" aria-pressed={!call.cameraEnabled} onClick={call.toggleCamera}>{call.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}</button>
            {call.status === 'failed' && <button className="secondary" onClick={call.retry} disabled={!ready}>Reconnect video</button>}
        </div>}
        {call.error && <div className="error" role="alert">{call.error}</div>}
    </section>;
}
