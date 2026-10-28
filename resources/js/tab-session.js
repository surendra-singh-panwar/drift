// sessionStorage survives reloads but can be copied when a tab is duplicated.
// A Web Lock prevents two live documents from using that copied owner token.
export async function acquireChatTab(channel) {
    const key = `drift:tab:${channel}`;
    let saved;
    try { saved = sessionStorage.getItem(key); } catch {}
    const token = navigator.locks ? (saved || crypto.randomUUID()) : crypto.randomUUID();

    function remember(value) {
        try { sessionStorage.setItem(key, value); } catch {}
    }
    if (!navigator.locks) {
        // Without Web Locks, retain the server's lease protection and automatic retry.
        return { token, release() {} };
    }
    function claim(value) {
        return new Promise((resolve, reject) => {
            navigator.locks.request(`drift:owner:${channel}:${value}`, { ifAvailable: true }, async lock => {
                if (!lock) {
                    resolve(await claim(crypto.randomUUID()));
                    return;
                }
                let release;
                const lifetime = new Promise(done => { release = done; });
                remember(value);
                resolve({ token: value, release });
                await lifetime;
            }).catch(reject);
        });
    }
    return claim(token);
}
