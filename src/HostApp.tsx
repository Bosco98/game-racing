import { useEffect, useRef, useState } from "react";
import { OpenControl, type TiltEvents, type HostSession } from "@bosco98/opencontrol-sdk";
import QRCode from "qrcode";
import { RacingGame, type GameSnapshot } from "./race";
import { CIRCUITS } from "./track";
import { loadRecords, recordTier, type MedalTier } from "./records";

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
  const mode = snapshot?.mode ?? "cruise";
  const circuit = CIRCUITS[snapshot?.circuitIndex ?? 0];
  const gp = mode === "gp";

  const showQr = inLobby && players.length === 0;
  useEffect(() => {
    if (showQr && joinUrl && qrRef.current) {
      QRCode.toCanvas(qrRef.current, joinUrl, { margin: 0, width: 328 }).catch(() => {});
    }
  }, [joinUrl, showQr]);

  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const countdown = snapshot?.countdown ?? -1;
  const spectators = players.filter((p) => p.spectator).length;
  const record = loadRecords()[circuit.id];
  const best = circuit.special === "endless" ? record?.bestDist : record?.bestMs;
  const result = snapshot?.result ?? null;

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
                {players.length === 0 ? (
                  <>
                    <div className="qr">
                      <canvas ref={qrRef} />
                    </div>
                    <div className="code-label">Room code</div>
                    <div className="code">{code ?? "····"}</div>
                    {joinUrl && <div className="url">{joinUrl.replace(/^https?:\/\//, "")}</div>}
                    <div className="hint">Scan the QR code or open the link on your phone (up to 4 racers)</div>
                  </>
                ) : (
                  <>
                    <div className="mode-tabs">
                      <span className={gp ? "" : "on"}>CRUISE</span>
                      <span className={gp ? "on" : ""}>GRAND PRIX</span>
                    </div>
                    <CircuitCard circuitIndex={snapshot?.circuitIndex ?? 0} best={best ?? null} />
                    <ul className="lobby-list">
                      {players.map((p) => (
                        <li key={p.id} className={p.ghost ? "ghost" : undefined}>
                          <span className="swatch" style={{ background: p.color }} />
                          {p.name}
                          {gp && <span className={`box-tag${p.manual ? " manual" : ""}`}>{p.manual ? "MANUAL" : "AUTO"}</span>}
                          <span className={p.ready ? "ready is-ready" : "ready"}>
                            {p.ghost ? "reconnecting…" : p.ready ? "READY" : "press A when ready"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="legend">
                      <span><b>A</b> ready</span>
                      <span><b>P1 GAS</b> next circuit</span>
                      <span><b>P1 BRAKE</b> mode</span>
                      {gp && <span><b>B</b> auto/manual</span>}
                      <span className="keys"><b>← →</b> circuit · <b>M</b> mode (keyboard)</span>
                    </div>
                    <div className="room-line">
                      Room <b>{code}</b> · {joinUrl?.replace(/^https?:\/\//, "")}
                    </div>
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
            <h1>{circuit.name}</h1>
            {result && (
              <p className="race-medal">
                {result.tier ? `${medalIcon(result.tier)} ${result.tier.toUpperCase()}` : "No medal this time"}
                {" · "}
                {circuit.special === "endless" ? `${result.value}m` : formatTime(result.value)}
                {result.newRecord && <span className="new-record"> NEW RECORD!</span>}
              </p>
            )}
            <ol className="podium-list">
              {players
                .filter((p) => !p.spectator)
                .map((p) => (
                  <li key={p.id}>
                    <span className="place">{medal(p.place)}</span>
                    <span className="swatch" style={{ background: p.color }} />
                    {p.name}
                    {p.coins > 0 && <span className="coin-tag">● {p.coins}</span>}
                    <span className="time">
                      {p.busted
                        ? `BUSTED · ${p.distance}m`
                        : circuit.special === "endless"
                          ? `${p.distance}m`
                          : p.finishMs !== null
                            ? formatTime(p.finishMs)
                            : `DNF · ${p.distance}m`}
                    </span>
                  </li>
                ))}
            </ol>
            <div className="hint">
              Press A for a rematch · P1: GAS next circuit, BRAKE switch mode{gp ? " · B auto/manual" : ""}
            </div>
          </div>
        </div>
      )}

      {(phase === "racing" || phase === "countdown") && (
        <div className="race-chip">
          {circuit.name} · {code}
          {spectators > 0 && <span className="waiting"> · {spectators} waiting</span>}
        </div>
      )}
    </>
  );
}

function CircuitCard({ circuitIndex, best }: { circuitIndex: number; best: number | null }) {
  const circuit = CIRCUITS[circuitIndex];
  const tier = recordTier(circuit);
  return (
    <div className="circuit-card">
      <div className="circuit-strip">
        {CIRCUITS.map((c, i) => (
          <span key={c.id} className={i === circuitIndex ? "dot on" : "dot"} />
        ))}
      </div>
      <div className="circuit-name">
        {circuit.name}
        {circuit.special === "chase" && <span className="special-tag chase">PURSUIT</span>}
        {circuit.special === "endless" && <span className="special-tag endless">ENDLESS</span>}
      </div>
      <div className="circuit-tagline">{circuit.tagline}</div>
      <div className="circuit-best">
        {best !== null
          ? <>Best: {circuit.special === "endless" ? `${best}m` : formatTime(best)} {tier && medalIcon(tier)}</>
          : "No record yet"}
      </div>
    </div>
  );
}

function medalIcon(tier: MedalTier): string {
  return tier === "gold" ? "🥇" : tier === "silver" ? "🥈" : "🥉";
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
