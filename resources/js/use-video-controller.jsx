import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

const VideoRuntime = lazy(() => import('./VideoRuntime'));
const initial = { localStream: null, remoteStream: null, status: 'idle', error: '', microphoneEnabled: true,
    cameraEnabled: true, facingMode: 'user', switchingCamera: false };

// Keep WebRTC hooks and media components out of the text-chat entry bundle.
export function useVideoController(options, enabled) {
    const implementation = useRef(null);
    const [snapshot, setSnapshot] = useState(initial);
    const [loaded, setLoaded] = useState(false);
    const methods = useRef(null);
    if (!methods.current) methods.current = Object.fromEntries([
        'enableMedia', 'releaseMedia', 'suspendPeer', 'receiveSignal', 'toggleMicrophone', 'toggleCamera', 'switchCamera', 'retry',
    ].map(name => [name, (...args) => implementation.current?.[name](...args)]));
    const publish = useCallback((call, value) => {
        implementation.current = call;
        setLoaded(true);
        setSnapshot(previous => Object.keys(value).every(key => previous[key] === value[key]) ? previous : value);
    }, []);
    const [mounted, setMounted] = useState(enabled);
    useEffect(() => { if (enabled) setMounted(true); }, [enabled]);
    return { call: { ...snapshot, ...methods.current }, loaded,
        runtime: mounted ? <Suspense fallback={null}><VideoRuntime options={options} publish={publish} /></Suspense> : null };
}
