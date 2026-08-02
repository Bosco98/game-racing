import { useEffect, useRef, useState } from "react";
import { OpenControl, type TiltEvents, type HostSession } from "@bosco98/opencontrol-sdk";
import QRCode from "qrcode";
import { RacingGame, type GameSnapshot } from "./race";

export function HostApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrRef = useRef<HTMLCanvasElement>(null);
  const startedRef = useRef(false);

  const [code, setCode] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) return; // guard double-mount
    startedRef.current = true;

    let session: HostSession<TiltEvents> | undefined;
    let game: RacingGame | undefined;

    (async () => {
      try {
        session = await OpenControl.host<TiltEvents>({ controller: "tilt", maxPlayers: 4 });
        setCode(session.code);

        const url = session.getJoinUrl(new URL("controller.html", location.href).toString());
        setJoinUrl(url);

        game = new RacingGame(canvasRef.current!, session, setSnapshot);
      } catch (err) {
        setError((err as Error).message);
      }
    })();

    return () => {
      game?.destroy();
      session?.close();
    };
  }, []);

  const phase = snapshot?.phase ?? "lobby";
  const players = snapshot?.players ?? [];
  const inLobby = phase === "lobby";

  useEffect(() => {
    if (inLobby && joinUrl && qrRef.current) {
      QRCode.toCanvas(qrRef.current, joinUrl, { margin: 0, width: 328 }).catch(() => {});
    }
  }, [joinUrl, inLobby]);

  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const countdown = snapshot?.countdown ?? -1;
  const spectators = players.filter((p) => p.spectator).length;

  return (
    <>
      <canvas className="game-canvas" ref={canvasRef} />

      {inLobby && (
        <div className="overlay">
          <div className="join-card">
            <h1>Tilt Grand Prix</h1>
            <p className="sub">Your phone is the steering wheel — first to the finish wins</p>
            {error ? (
              <p className="error">Could not start session: {error}</p>
            ) : (
              <>
                <div className="qr">
                  <canvas ref={qrRef} />
                </div>
                <div className="code-label">Room code</div>
                <div className="code">{code ?? "····"}</div>
                {joinUrl && <div className="url">{joinUrl.replace(/^https?:\/\//, "")}</div>}
                {players.length === 0 ? (
                  <div className="hint">Scan the QR code or open the link on your phone (up to 4 racers)</div>
                ) : (
                  <>
                    <ul className="lobby-list">
                      {players.map((p) => (
                        <li key={p.id} className={p.ghost ? "ghost" : undefined}>
                          <span className="swatch" style={{ background: p.color }} />
                          {p.name}
                          <span className={p.ready ? "ready is-ready" : "ready"}>
                            {p.ghost ? "reconnecting…" : p.ready ? "READY" : "press A when ready"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="hint">Race starts when every racer presses A</div>
                  </>
                )}
                {isLocalhost && (
                  <div className="warn">
                    You opened this page as <b>localhost</b> — phones can't reach that. Use the
                    Network URL that <code>npm run dev</code> printed.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {countdown >= 0 && (
        <div className="overlay">
          <div key={countdown} className="countdown">
            {countdown === 0 ? "GO!" : countdown}
          </div>
        </div>
      )}

      {phase === "finished" && (
        <div className="overlay">
          <div className="join-card podium">
            <h1>Race results</h1>
            <ol className="podium-list">
              {players
                .filter((p) => !p.spectator)
                .map((p) => (
                  <li key={p.id}>
                    <span className="place">{medal(p.place)}</span>
                    <span className="swatch" style={{ background: p.color }} />
                    {p.name}
                    <span className="time">
                      {p.finishMs !== null ? formatTime(p.finishMs) : `DNF · ${p.distance}m`}
                    </span>
                  </li>
                ))}
            </ol>
            <div className="hint">Press A on your phone for a rematch</div>
          </div>
        </div>
      )}

      {(phase === "racing" || phase === "countdown") && (
        <div className="race-chip">
          {code}
          {spectators > 0 && <span className="waiting"> · {spectators} waiting</span>}
        </div>
      )}
    </>
  );
}

function medal(place: number): string {
  return place === 1 ? "🥇" : place === 2 ? "🥈" : place === 3 ? "🥉" : `${place}.`;
}

function formatTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(1).padStart(4, "0");
  return minutes > 0 ? `${minutes}:${seconds}` : `${seconds}s`;
}
