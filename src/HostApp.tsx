import { useEffect, useRef, useState } from "react";
import { OpenControl, type TiltEvents, type HostSession } from "@opencontrol/sdk";
import QRCode from "qrcode";
import { RacingGame, type LeaderboardRow } from "./game";

export function HostApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrRef = useRef<HTMLCanvasElement>(null);
  const startedRef = useRef(false);

  const [code, setCode] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) return; // guard double-mount
    startedRef.current = true;

    let session: HostSession<TiltEvents> | undefined;
    let game: RacingGame | undefined;

    (async () => {
      try {
        session = await OpenControl.host<TiltEvents>({ controller: "tilt" });
        setCode(session.code);

        const url = session.getJoinUrl(new URL("controller.html", location.href).toString());
        setJoinUrl(url);

        game = new RacingGame(canvasRef.current!, session, {
          onPlayersChange: setPlayerCount,
          onLeaderboard: setLeaderboard,
        });
      } catch (err) {
        setError((err as Error).message);
      }
    })();

    return () => {
      game?.destroy();
      session?.close();
    };
  }, []);

  useEffect(() => {
    if (joinUrl && qrRef.current) {
      QRCode.toCanvas(qrRef.current, joinUrl, { margin: 0, width: 328 }).catch(() => {});
    }
  }, [joinUrl, playerCount]);

  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  return (
    <>
      <canvas className="game-canvas" ref={canvasRef} />

      {playerCount === 0 && (
        <div className="overlay">
          <div className="join-card">
            <h1>OpenControl Racing</h1>
            <p className="sub">Your phone is the steering wheel — tilt to steer</p>
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
                <div className="hint">Scan the QR code or open the link on your phone</div>
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

      {playerCount > 0 && (
        <div className="hud">
          <div className="hud-code">{code}</div>
          <ol>
            {leaderboard.map((row, position) => (
              <li key={row.id} className={row.ghost ? "ghost" : undefined}>
                <span className="swatch" style={{ background: row.color }} />
                {position + 1}. {row.name}
                <span className="dist">{row.distance} m</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
