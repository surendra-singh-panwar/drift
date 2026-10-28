import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createInertiaApp, Head } from '@inertiajs/react';
import axios from 'axios';
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { acquireChatTab } from './tab-session';
import { useVideoController } from './use-video-controller';
const VideoPanel = lazy(() => import('./VideoPanel').then(module => ({ default: module.VideoPanel })));
const GroupVideoPanel = lazy(() => import('./GroupVideoPanel').then(module => ({ default: module.GroupVideoPanel })));

axios.defaults.headers.common['X-CSRF-TOKEN'] = document.querySelector('meta[name="csrf-token"]').content;
axios.defaults.headers.common['X-Requested-With'] = 'XMLHttpRequest';
window.Pusher = Pusher;

function Icon({ name, size = 22 }) {
    const paths = { chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z', arrow: 'M5 12h14m-6-6 6 6-6 6', send: 'm22 2-7 20-4-9-9-4 20-7ZM22 2 11 13', shield: 'M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Zm-4-11 3 3 5-5', next: 'm5 4 10 8L5 20V4Zm14 0v16', stop: 'M6 6h12v12H6z', globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z' };
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.chat} /></svg>;
}

function ChatPage({ channel, reverb, webrtc }) {
    const [theme, setTheme] = useState(() => {
        try { return localStorage.getItem('drift-theme') === 'light' ? 'light' : 'dark'; }
        catch { return 'dark'; }
    });
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem('drift-theme', theme); } catch {}
    }, [theme]);
    const [state, setState] = useState({ status: 'idle', room: null, online: null });
    const stateRef = useRef(state);
    const [messages, setMessages] = useState([]);
    const [text, setText] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [ready, setReady] = useState(false);
    const [connection, setConnection] = useState('connecting');
    const [conflict, setConflict] = useState(false);
    const [busy, setBusy] = useState(false);
    const [sending, setSending] = useState(false);
    const messagePending = useRef(false);
    const [selectedMode, setSelectedMode] = useState('text');
    const [mediaBusy, setMediaBusy] = useState(false);
    const [reportTarget, setReportTarget] = useState(null);
    const [reportReason, setReportReason] = useState('');
    const [groupSuspended, setGroupSuspended] = useState(false);
    const groupPeers = useRef(new Map());
    const groupLeaseValid = useRef(false);
    const [leaseExpired, setLeaseExpired] = useState(false);
    const groupLeaseTimer = useRef(null);
    const bottom = useRef(null);
    const tab = useRef(null);
    const subscribed = useRef(false);
    const requestBusy = useRef(false);
    const controlEpoch = useRef(0);
    const stopping = useRef(false);
    const controlPending = useRef(false);
    const iceCache = useRef(null);
    const video = useVideoController({
        state, ready, configuration: webrtc, sendSignal, getIceConfiguration, mediaAllowed: !leaseExpired,
        onMediaEnded: () => { void control('stop'); },
    }, selectedMode !== 'text' || state.mode === 'video' || state.mode === 'group');
    const call = video.call;
    const mode = state.status === 'idle' ? selectedMode : (state.mode || 'text');
    async function getIceConfiguration(signal) {
        const current = stateRef.current;
        const membership = current.epochs?.[current.self];
        const key = current.room + ':' + (membership || '');
        const cached = iceCache.current;
        if (cached?.key === key && cached.until > Date.now()) return cached.pending;
        const pending = axios.post('/chat/ice', { tab: tab.current, room: current.room, ...(membership ? { membership } : {}) }, { timeout: 10000 }).then(({ data }) => {
            if (stateRef.current.room !== current.room || stateRef.current.epochs?.[current.self] !== membership) throw new Error('Chat changed while retrieving video configuration.');
            if (iceCache.current?.pending === pending) iceCache.current.until = data.expiresAt ? data.expiresAt * 1000 - 120000 : Date.now() + 300000;
            return data;
        }).catch(error => { if (iceCache.current?.pending === pending) iceCache.current = null; throw error; });
        iceCache.current = { key, pending, until: Date.now() + 10000 };
        return pending;
    }
    function confirmGroupLease() {
        groupLeaseValid.current = true;
        setLeaseExpired(false);
        clearTimeout(groupLeaseTimer.current);
        groupLeaseTimer.current = setTimeout(() => {
            groupLeaseValid.current = false;
            if (['video', 'group'].includes(stateRef.current.mode)) { setLeaseExpired(true); setReady(false); }
        }, 45_000);
    }
    async function sendSignal(packet, signal) {
        if (!tab.current || !subscribed.current || packet.room !== stateRef.current.room) throw new Error('Chat is no longer active.');
        if (packet.to && (stateRef.current.epochs?.[packet.to] !== packet.targetMembership || stateRef.current.epochs?.[stateRef.current.self] !== packet.membership)) return;
        await axios.post('/chat/signal', { tab: tab.current, ...packet }, { timeout: packet.to ? 30_000 : 10_000, signal });
        if (stateRef.current.room === packet.room && !stopping.current) confirmGroupLease();
    }
    function sync(data) {
        if (data.status === 'idle') data = { ...data, members: [], epochs: {} };
        const old = stateRef.current;
        if ((data.revision ?? 0) < (old.revision ?? 0)) return;
        if (data.status === 'idle') { setLeaseExpired(false); groupLeaseValid.current = false; clearTimeout(groupLeaseTimer.current); }
        for (const [peer, handler] of groupPeers.current) {
            if (data.room !== old.room || !data.members?.includes(peer) || data.status === 'idle') handler.close();
        }
        if (data.room !== old.room) setMessages([]);
        if (data.room !== old.room) setReportTarget(null);
        if (old.status === 'connected' && data.status === 'idle') setNotice('Stranger disconnected.');
        if (old.status !== 'idle' && data.status === 'idle') call.releaseMedia();
        if (data.status !== 'idle' && data.mode) setSelectedMode(data.mode);
        stateRef.current = data;
        setState(data);
    }
    function add(message, own = false) {
        if (message.room !== stateRef.current.room) return;
        setMessages(previous => previous.some(m => m.id === message.id && m.own === own) ? previous : [...previous, { ...message, own }]);
    }
    async function act(action, data = {}) {
        if (!tab.current || requestBusy.current) return;
        // Retry an offline Stop before renewing or resuming an abandoned call.
        if (stopping.current) action = 'stop';
        requestBusy.current = true;
        setBusy(true); setError('');
        try {
            const response = await axios.post(`/chat/${action}`, { tab: tab.current, membership: stateRef.current.epochs?.[stateRef.current.self], ...data }, { timeout: stateRef.current.mode === 'group' || data.mode === 'group' ? 30_000 : 10_000 });
            if (action === 'stop') stopping.current = false;
            sync(response.data);
            if (['video', 'group'].includes(response.data.mode) && response.data.status === 'connected') confirmGroupLease();
            setConflict(false);
            setReady(subscribed.current);
            if (action !== 'heartbeat') setNotice('');
            return response.data;
        } catch (e) {
            setError(e.response?.data?.message || 'Connection failed. Check your connection and try again.');
            // Keep healthy mesh edges during a slow HTTP request while the
            // private socket and a recently server-validated lease remain live.
            const groupGrace = stateRef.current.mode === 'group' && groupLeaseValid.current && subscribed.current;
            if (e.response?.status === 409 || (action === 'heartbeat' && !groupGrace)) {
                setConflict(e.response?.status === 409);
                setReady(false);
            }
        } finally { requestBusy.current = false; setBusy(false); }
    }
    async function control(action, data = {}) {
        if (action === 'stop') {
            controlEpoch.current++;
            stopping.current = true;
            setGroupSuspended(true);
            groupPeers.current.forEach(handler => handler.close());
            call.releaseMedia();
            while (requestBusy.current) await new Promise(resolve => setTimeout(resolve, 50));
            const result = await act('stop');
            if (result) setGroupSuspended(false);
            return result;
        }
        if (controlPending.current || requestBusy.current || messagePending.current || !ready || stopping.current) return;
        controlPending.current = true;
        const epoch = ++controlEpoch.current;
        if (action === 'next' || action === 'block') {
            setGroupSuspended(true);
            call.suspendPeer();
            groupPeers.current.forEach(handler => handler.close());
        }
        const requestedMode = action === 'start' ? selectedMode : (stateRef.current.mode || 'text');
        setMediaBusy(true);
        try {
            if (requestedMode !== 'text' && !await call.enableMedia({ group: requestedMode === 'group' })) return;
            // Permission prompts may outlast a heartbeat or a socket connection.
            while (requestBusy.current) await new Promise(resolve => setTimeout(resolve, 50));
            if (epoch !== controlEpoch.current) return;
            if (!subscribed.current) { call.releaseMedia(); return; }
            const result = await act(action, action === 'start' ? { mode: requestedMode } : data);
            if (!result) {
                call.releaseMedia();
                stopping.current = true;
                await act('stop');
            }
            return result;
        } finally { controlPending.current = false; setMediaBusy(false); setGroupSuspended(false); }
    }
    useEffect(() => {
        let echo, timer, owner, cancelled = false;
        const offline = () => {
            subscribed.current = false;
            setReady(false);
            setConnection('disconnected');
            echo?.connector.pusher.disconnect();
        };
        const online = () => { echo?.connector.pusher.connect(); };
        async function connect() {
            owner = await acquireChatTab(channel);
            if (cancelled) { owner.release(); return; }
            tab.current = owner.token;
            echo = new Echo({ broadcaster: 'reverb', key: reverb?.key || import.meta.env.VITE_REVERB_APP_KEY, wsHost: reverb?.host || import.meta.env.VITE_REVERB_HOST || location.hostname, wsPort: Number(reverb?.port || import.meta.env.VITE_REVERB_PORT || 8080), wssPort: Number(reverb?.port || import.meta.env.VITE_REVERB_PORT || 8080), forceTLS: (reverb?.scheme || import.meta.env.VITE_REVERB_SCHEME) === 'https', enabledTransports: ['ws', 'wss'] });
            const subscription = echo.private(channel);
            subscription.subscribed(() => { subscribed.current = true; setConnection('connected'); act('heartbeat'); });
            subscription.error(() => { subscribed.current = false; setReady(false); setError('Unable to authorize the private chat connection.'); });
            subscription.listen('.chat.updated', data => {
                if (data.type === 'matched') { sync({ ...stateRef.current, revision: data.revision, status: 'connected', room: data.room, mode: data.mode, initiator: data.initiator }); setNotice('You’re connected. Say hello!'); }
                if (data.type === 'message') add(data);
                if (data.type === 'group-members' && data.members.includes(channel.replace('anonymous.', ''))) {
                    sync({ ...stateRef.current, ...data, self: channel.replace('anonymous.', ''), status: 'connected' });
                }
                if (data.type === 'signal') {
                    const current = stateRef.current;
                    if (current.mode === 'group') {
                        if (data.room === current.room && data.membership === current.epochs?.[data.from] && data.targetMembership === current.epochs?.[current.self]) groupPeers.current.get(data.from)?.receive(data);
                    } else call.receiveSignal(data);
                }
                if (data.type === 'ended' && data.room === stateRef.current.room) { sync({ ...stateRef.current, revision: data.revision, status: 'idle', room: null }); setNotice(data.reason); }
            });
            echo.connector.pusher.connection.bind('state_change', ({ current }) => {
                setConnection(current);
                if (current !== 'connected') { subscribed.current = false; setReady(false); }
            });
            timer = setInterval(() => { if (subscribed.current && echo.connector.pusher.connection.state === 'connected') act('heartbeat'); }, 10000);
            window.addEventListener('offline', offline);
            window.addEventListener('online', online);
        }
        connect().catch(() => { setReady(false); setError('Unable to initialize the chat connection. Please reload.'); });
        return () => { cancelled = true; subscribed.current = false; clearInterval(timer); clearTimeout(groupLeaseTimer.current); groupLeaseValid.current = false; window.removeEventListener('offline', offline); window.removeEventListener('online', online); echo?.disconnect(); owner?.release(); };
    }, [channel]);
    useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'instant', block: 'nearest' }); }, [messages, notice]);
    async function send(e) {
        e.preventDefault();
        if (!text.trim() || messagePending.current || controlPending.current || stopping.current || !ready || stateRef.current.status !== 'connected') return;
        const current = stateRef.current;
        const message = { id: crypto.randomUUID(), room: current.room, text: text.trim() };
        messagePending.current = true;
        setSending(true);
        setError('');
        // Render immediately; keep session heartbeats independent of message delivery.
        add({ ...message, pending: true }, true);
        setText('');
        try {
            await axios.post('/chat/message', { tab: tab.current, membership: current.epochs?.[current.self], ...message }, { timeout: 10000 });
            setMessages(previous => previous.map(m => m.id === message.id && m.own ? { ...m, pending: false } : m));
        } catch (e) {
            if (stateRef.current.room === message.room) {
                setMessages(previous => previous.filter(m => !(m.id === message.id && m.own)));
                setText(draft => draft || message.text);
                setError(e.response?.data?.message || 'Message could not be confirmed. Please try again.');
            }
        } finally {
            messagePending.current = false;
            setSending(false);
        }
    }
    return <>{video.runtime}<Head title="Drift | Meet someone new" />
        <header className="topbar"><a href="/" className="brand"><span className="brand-icon"><Icon name="chat" /></span>drift<span className="brand-dot">.</span></a><span className="header-note">Good conversations start here.</span><div className="header-actions"><div className="theme-switch" role="group" aria-label="Color theme"><button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>Light</button><button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</button></div><span className="online"><i />{state.online ?? '—'} online<span className="live-label"> right now</span></span></div></header>
        <main className="workspace"><aside className="intro"><span className="eyebrow"><span /> CONNECT WITH SOMEONE NEW</span><h1>A new face.<br /><em>A fresh conversation.</em></h1><p className="intro-copy">Choose a chat, meet someone new, and see where the conversation goes.</p><div className="intro-features"><div><span className="feature-number">01</span><div><strong>Make it your kind of chat</strong><p>Text, video, or a group of up to 8.</p></div></div><div><span className="feature-number">02</span><div><strong>Jump right in</strong><p>No account or profile needed.</p></div></div><div><span className="feature-number">03</span><div><strong>Stay in control</strong><p>Skip or leave a conversation anytime.</p></div></div></div><div className="intro-safety"><Icon name="shield" size={18} /><span>Keep personal details private. Be kind.</span></div></aside>
        <section className={`chat-panel ${mode !== 'text' ? 'video-mode' : ''}`} aria-label="Anonymous chat"><div className="chat-header"><div className="room-icon"><Icon name="chat" /></div><div><h2>Your conversation</h2><p><i className={state.status === 'connected' ? 'connected-dot' : ''} />{state.status === 'connected' ? (mode === 'group' ? 'Connected with your group' : 'Connected with a stranger') : state.status === 'searching' ? 'Finding your next connection' : 'Choose a mode to get started'}</p></div><span className="private"><Icon name="shield" size={14} /> Private</span></div>
        <div className="chat-modes" role="group" aria-label="Chat mode"><button type="button" aria-pressed={mode === 'text'} disabled={state.status !== 'idle' || busy || mediaBusy} onClick={() => { call.releaseMedia(); setSelectedMode('text'); }}>Text chat</button><button type="button" aria-pressed={mode === 'video'} disabled={state.status !== 'idle' || busy || mediaBusy} onClick={() => setSelectedMode('video')}>Video chat</button><button type="button" aria-pressed={mode === 'group'} disabled={state.status !== 'idle' || busy || mediaBusy} onClick={() => setSelectedMode('group')}>Group video chat</button></div><Suspense fallback={<div className="system" role="status">Loading video controls...</div>}>{mode === 'group' && <GroupVideoPanel call={call} state={state} ready={ready} busy={busy || mediaBusy} configuration={webrtc} getIceConfiguration={getIceConfiguration} mediaAllowed={!leaseExpired} sendSignal={sendSignal} registry={groupPeers} suspended={groupSuspended} safety={(action, target) => { if (action === 'report') { setReportTarget(target); setReportReason(''); } else control('block', { room: state.room, target }); }} />}{mode === 'video' && <VideoPanel call={call} state={state} ready={ready} busy={busy || mediaBusy} resume={call.enableMedia} />}</Suspense><div className="chat-window" role="log" aria-live="polite">{state.status === 'idle' && !messages.length ? <div className="welcome"><div className="orbit"><span className="spark spark-one">✦</span><span className="welcome-icon"><Icon name="chat" size={42} /></span><span className="spark spark-two">✧</span></div><h2>{mode === 'group' ? 'Meet your next group.' : mode === 'video' ? 'Say hello, face to face.' : 'Your next hello is waiting.'}</h2><p>{mode === 'group' ? 'Join up to 7 other people in a video conversation.' : mode === 'video' ? 'Start a one-to-one video conversation.' : 'Start a chat and we will find someone for you.'}</p>{!ready && <span className="connection-hint">{conflict ? 'Close the other chat tab. This page will retry automatically.' : connection === 'connected' ? 'Checking chat session…' : 'Connecting to chat service…'}</span>}</div> : state.status === 'searching' ? <div className="welcome"><div className="searching"><span /><span /><span /></div><h2>Somewhere, someone’s saying hi.</h2><p>Looking for someone to chat with...</p></div> : <><div className="system">{mode === 'group' ? 'Be kind and keep personal details private in your group.' : "You’re connected with a stranger. Be kind, be yourself."}</div>{messages.map(m => <div key={`${m.own}-${m.id}`} className={`message-row ${m.own ? 'own' : ''}`}><span className="message-label">{m.own ? (m.pending ? 'Sending...' : 'You') : mode === 'group' ? 'Participant ' + (m.from || '').slice(0, 6) : 'Stranger'}</span><div className="bubble">{m.text}</div></div>)}</>}{notice && <div className="system">{notice}</div>}<div ref={bottom} /></div>
        {reportTarget && <form className="group-report" onSubmit={async e => { e.preventDefault(); const result = await act('report', { room: state.room, target: reportTarget, reason: reportReason }); if (result?.report) { setNotice('Report received for moderator review. Reference: ' + result.report); setReportTarget(null); } }}><label>Reason for reporting<textarea aria-label="Report reason" minLength={3} maxLength={1000} required value={reportReason} onChange={e => setReportReason(e.target.value)} /></label><button type="submit" className="secondary" disabled={busy}>Submit report</button><button type="button" className="secondary" onClick={() => setReportTarget(null)}>Cancel</button></form>}{error && <div className="error" role="alert">{error}</div>}
        <form className="composer" onSubmit={send}><input aria-label="Message" placeholder={state.status === 'connected' ? 'Type a message...' : 'Start a chat to send a message'} value={text} maxLength={2000} onChange={e => setText(e.target.value)} disabled={state.status !== 'connected' || !ready} /><span className="char-count">{text.length ? `${text.length}/2000` : '↵ to send'}</span><button className="send" aria-label="Send message" disabled={!text.trim() || state.status !== 'connected' || !ready || sending}><Icon name="send" size={19} /></button></form>
        <div className="chat-controls"><button className="primary" disabled={!ready || busy || sending || mediaBusy || (mode !== 'text' && !video.loaded)} onClick={() => control(state.status === 'idle' ? 'start' : 'next')}><Icon name={state.status === 'idle' ? 'chat' : 'next'} size={17} />{state.status === 'idle' ? 'Start chat' : mode === 'group' ? 'Next group' : 'Next stranger'}</button><button className="secondary" disabled={state.status === 'idle' && !mediaBusy && !call.localStream} onClick={() => control('stop')}><Icon name="stop" size={16} />Stop</button><span className="connection-state"><i className={ready ? 'connected-dot' : ''} />{ready ? 'Chat service connected' : conflict ? 'Chat active in another tab' : connection === 'connected' ? 'Checking chat session…' : 'Reconnecting…'}</span></div></section></main>
        <footer><span>&copy; {new Date().getFullYear()} Drift</span><span>Real people. Respectful conversations.</span></footer></>;
}
createInertiaApp({ resolve: () => ChatPage, setup({ el, App, props }) { createRoot(el).render(<App {...props} />); } });
