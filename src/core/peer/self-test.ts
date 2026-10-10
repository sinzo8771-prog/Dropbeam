/**
 * In-app connection self-test (PRD FR-62).
 *
 * Two `RTCPeerConnection`s inside the same tab are wired back to back:
 * A offers to B, B answers, ICE candidates cross directly, and a small
 * data-channel round trip ("ping" → "pong") proves the whole path —
 * offer/answer, DTLS and the data channel — actually works in this
 * browser. Nothing leaves the device: no STUN, no signalling server
 * (the descriptions are handed over in memory), which is also why the
 * connection succeeds even with Across networks off.
 *
 * The failure stage mirrors the PRD 7.1 vocabulary so the UI can reuse
 * the same wording as a real connection failure: `gathering` (no
 * network path found) vs `connecting` (descriptions exchanged, the
 * handshake itself stuck).
 */

export type SelfTestStage = "unsupported" | "gathering" | "connecting";

export type SelfTestResult =
  { ok: true; ms: number } | { ok: false; ms: number; stage: SelfTestStage };

export type SelfTestOptions = {
  /** Injected in tests; defaults to the platform constructor. */
  createPeerConnection?: () => RTCPeerConnection;
  /** Overall cap. The loopback path is local, so 10 s is generous. */
  timeoutMs?: number;
};

type PC = RTCPeerConnection;

/**
 * Run one self-test. Always resolves (never rejects) within
 * `timeoutMs`, and closes both connections on every exit path so an
 * abandoned run cannot leak handlers.
 */
export function runSelfTest(opts: SelfTestOptions = {}): Promise<SelfTestResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const create = (): PC | null => {
    if (opts.createPeerConnection) return opts.createPeerConnection();
    const Ctor = (globalThis as { RTCPeerConnection?: new () => PC }).RTCPeerConnection;
    return Ctor ? new Ctor() : null;
  };

  return new Promise<SelfTestResult>((resolve) => {
    let stage: "gathering" | "connecting" = "gathering";
    let settled = false;

    let maybeA: PC | null = null;
    let maybeB: PC | null = null;
    try {
      maybeA = create();
      maybeB = create();
    } catch {
      maybeA?.close();
    }
    if (!maybeA || !maybeB) {
      maybeA?.close();
      maybeB?.close();
      resolve({ ok: false, ms: 0, stage: "unsupported" });
      return;
    }
    // Const aliases: the closures below capture these, and unlike the
    // mutable bindings above they keep the narrowing past the guard.
    const a = maybeA;
    const b = maybeB;

    const finish = (result: SelfTestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.close();
      b.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, ms: Date.now() - started, stage }),
      timeoutMs,
    );

    const done = (channel: RTCDataChannel): void => {
      channel.onopen = null;
      channel.onmessage = null;
      finish({ ok: true, ms: Date.now() - started });
    };
    const failed = (): void => finish({ ok: false, ms: Date.now() - started, stage });

    // Candidates are buffered per side until the remote description
    // lands: addIceCandidate rejects without one (spec behaviour).
    const toB: RTCIceCandidate[] = [];
    const toA: RTCIceCandidate[] = [];
    let bReady = false;
    let aReady = false;
    const flush =
      (remote: PC, queue: RTCIceCandidate[], mark: () => void) => async (): Promise<void> => {
        mark();
        for (const candidate of queue.splice(0)) {
          await remote.addIceCandidate(candidate).catch(() => undefined);
        }
      };
    const deliver =
      (remote: PC, queue: RTCIceCandidate[], ready: () => boolean) =>
      (event: RTCPeerConnectionIceEvent): void => {
        const candidate = event.candidate;
        if (!candidate) return; // end-of-candidates: nothing to add
        if (!ready()) {
          queue.push(candidate);
          return;
        }
        void remote.addIceCandidate(candidate).catch(() => undefined);
      };

    // Everything below must never reject the returned promise: any
    // synchronous wiring error becomes a failed result instead.
    try {
      a.onicecandidate = deliver(b, toB, () => bReady);
      b.onicecandidate = deliver(a, toA, () => aReady);

      const channel = a.createDataChannel("dropbeam-self-test");
      channel.onmessage = (event: MessageEvent) => {
        if (event.data === "pong") done(channel);
      };
      channel.onopen = () => {
        if (settled) return;
        stage = "connecting";
        // A send on a just-closed channel would throw inside the
        // event callback, outside any of our guards.
        try {
          channel.send("ping");
        } catch {
          failed();
        }
      };
      b.ondatachannel = (event: RTCDataChannelEvent) => {
        const reply = event.channel;
        reply.onmessage = (msg: MessageEvent) => {
          if (settled) return;
          if (msg.data === "ping") {
            try {
              reply.send("pong");
            } catch {
              failed();
            }
          }
        };
      };

      a.onconnectionstatechange = () => {
        if (a.connectionState === "failed") failed();
      };
      b.onconnectionstatechange = () => {
        if (b.connectionState === "failed") failed();
      };

      void (async () => {
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(a.localDescription as RTCSessionDescriptionInit);
        await flush(b, toB, () => (bReady = true))();
        stage = "connecting";
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(b.localDescription as RTCSessionDescriptionInit);
        await flush(a, toA, () => (aReady = true))();
      })().catch(failed);
    } catch {
      failed();
    }
  });
}
