import { useEffect, useRef, useState } from "react";
import { OpenControl, type ControllerSession } from "@opencontrol/sdk";

type Phase = "enter-code" | "joining" | "connected" | "reconnecting";

export function ControllerApp() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ControllerSession | null>(null);
  const autoJoinedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("enter-code");
  const [codeInput, setCodeInput] = useState("");
  const [error, setError] = useState("");

  const join = async (room: string) => {
    room = room.trim();
    if (room.length < 4) {
      setError("Enter the 4-letter room code");
      return;
    }
    setPhase("joining");
    setError("");
    try {
      const session = await OpenControl.join({
        room,
        controller: "tilt",
        mount: mountRef.current!,
      });
      sessionRef.current = session;
      setPhase("connected");
      keepAwake();

      session.on("disconnect", () => setPhase("reconnecting"));
      session.on("reconnect", () => setPhase("connected"));
      session.on("close", ({ reason }) => {
        sessionRef.current = null;
        setPhase("enter-code");
        setError(
          reason === "session-ended" ? "The host ended the game" :
          reason === "lost" ? "Connection lost" : "",
        );
      });
    } catch (err) {
      setPhase("enter-code");
      const name = (err as Error).name;
      setError(
        name === "RoomNotFoundError" ? "No game found for that code" :
        name === "JoinRejectedError" ? "The game is full" :
        "Could not connect — try again",
      );
      console.error(err);
    }
  };

  useEffect(() => {
    if (autoJoinedRef.current) return;
    autoJoinedRef.current = true;
    const room = new URLSearchParams(location.search).get("room");
    if (room) {
      setCodeInput(room.toUpperCase());
      void join(room);
    }
    return () => sessionRef.current?.leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* The SDK renders the tilt controller UI into this div. */}
      <div className="controller-root" ref={mountRef} />

      {phase === "reconnecting" && <div className="banner">Reconnecting…</div>}

      {(phase === "enter-code" || phase === "joining") && (
        <div className="screen">
          <h1>Join the race</h1>
          <p>Enter the room code shown on the big screen</p>
          <input
            value={codeInput}
            maxLength={4}
            autoComplete="off"
            autoCapitalize="characters"
            placeholder="ABCD"
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && join(codeInput)}
          />
          <button disabled={phase === "joining"} onClick={() => join(codeInput)}>
            {phase === "joining" ? "Connecting…" : "Join"}
          </button>
          <div className="error">{error}</div>
        </div>
      )}
    </>
  );
}

// Keep the phone screen on while playing (best effort).
async function keepAwake() {
  try {
    if (navigator.wakeLock) await navigator.wakeLock.request("screen");
  } catch {
    /* not critical */
  }
}
