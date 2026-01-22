import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import mqtt from "mqtt";
import type { MqttClient } from "mqtt";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/control")({
  component: Dashboard,
});

// ===================== CONFIG =====================
const BROKER_URL = "wss://rude-mink-spliff-b5348244.koyeb.app/mqtt";
const DEVICE_ID = "3C893E124B00";
const TOPIC_BASE = "fsrmag";

const COLOR_MAGNET = "#7C3AED"; // fiolet
const COLOR_PRESS = "#22C55E"; // zielony
const WINDOW_MS = 30_000; // Okno czasu: 30 sekund
const MAX_VIEW_POINTS = 1200; // limit punktów renderowanych na wykresie (wydajność)

const G0 = 9.81; // [m/s^2] przyspieszenie ziemskie do przeliczenia g -> N

function gramsToNewtons(m_g: number) {
  // m_g: masa w gramach (równoważnik), wynik: siła w niutonach
  return (m_g / 1000) * G0;
}

type EspState = {
  t_ms?: number;
  mv?: number;
  r?: number;
  g?: number;
  mode?: number;
  manual?: number;
  pulseHz?: number;
  pulseAmp?: number;
  pulseWave?: number;
  trackTarget?: number;
  trackKp?: number;
  trackMax?: number;
  magOutPct?: number;
};

type Point = {
  t: number;
  pressure: number;
  magnet: number;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function modeLabel(m?: number) {
  if (m === 0) return "MANUAL";
  if (m === 1) return "PULSE";
  if (m === 2) return "TRACK";
  return "—";
}
function formatClock(ms: number) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], {
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 1,
  } as any);
}

function estimateMagnetPct(
  state: EspState,
  nowMs: number,
  pulseStartMs?: number | null,
) {
  // Prefer actual output reported by ESP (eliminates phase mismatch)
  if (typeof state.magOutPct === "number") {
    return clamp(state.magOutPct, 0, 100);
  }

  const mode = state.mode ?? 0;

  // MANUAL
  if (mode === 0) return clamp(state.manual ?? 0, 0, 100);

  // TRACK (bazuje na wartości zwrotnej z ESP w jednostkach urządzenia)
  if (mode === 2) {
    const g = state.g ?? 0;
    const target = state.trackTarget ?? 0;
    const kp = state.trackKp ?? 0;
    const maxPct = state.trackMax ?? 100;
    return clamp(Math.round(kp * (target - g)), 0, maxPct);
  }

  // PULSE
  const hz = Math.max(0.01, state.pulseHz ?? 1);
  const amp = clamp(state.pulseAmp ?? 0, 0, 100);
  const wave = state.pulseWave ?? 0;

  // Ważne: fazę liczymy od momentu wejścia w tryb PULSE, a nie od epoki czasu.
  // To zmniejsza pozorne przesunięcie fazowe wynikające z opóźnień sieci i startu trybu.
  const t0 = typeof pulseStartMs === "number" ? pulseStartMs : 0;
  const tSec = (nowMs - t0) / 1000;
  const phase = (tSec * hz) % 1;

  if (wave === 0) {
    const s = 0.5 * (Math.sin(2 * Math.PI * phase) + 1);
    return clamp(Math.round(s * amp), 0, 100);
  }

  return phase < 0.5 ? amp : 0;
}

const StatusDot = ({ active, label }: { active: boolean; label: string }) => (
  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground bg-secondary/50 px-2 py-1 rounded-full border border-border/50">
    <div
      className={`h-2 w-2 rounded-full transition-colors duration-300 ${active ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" : "bg-red-500/50"}`}
    />
    <span>{label}</span>
  </div>
);

function Dashboard() {
  const topics = React.useMemo(() => {
    const id = DEVICE_ID.trim();
    return {
      cmd: `${TOPIC_BASE}/${id}/cmd`,
      state: `${TOPIC_BASE}/${id}/state`,
      status: `${TOPIC_BASE}/${id}/status`,
    };
  }, []);

  const clientRef = React.useRef<MqttClient | null>(null);

  // Throttle UI/state updates to avoid rerendering on every MQTT packet
  const lastStateRef = React.useRef<EspState>({});
  const uiUpdateTimerRef = React.useRef<number | null>(null);

  // Align PULSE phase to the moment we enter PULSE mode (reduces apparent phase shift)
  const pulseStartMsRef = React.useRef<number | null>(null);
  const lastModeRef = React.useRef<number | null>(null);
  // Map ESP millis() timeline to browser time to avoid jitter/phase artifacts.
  // offsetMs = Date.now() - esp_t_ms
  const espTimeOffsetMsRef = React.useRef<number | null>(null);

  const scheduleUiUpdate = React.useCallback(() => {
    if (uiUpdateTimerRef.current !== null) return;

    // ~10 Hz UI refresh is sufficient; chart is updated separately via RAF
    uiUpdateTimerRef.current = window.setTimeout(() => {
      uiUpdateTimerRef.current = null;

      const obj = lastStateRef.current;
      setState(obj);

      // Keep MANUAL slider synced, but do it on the throttled cadence
      if (
        !draggingRef.current &&
        (obj.mode ?? 0) === 0 &&
        typeof obj.manual === "number"
      ) {
        setManualPct(obj.manual);
      }
    }, 100);
  }, []);

  const [connected, setConnected] = React.useState(false);
  const [statusText, setStatusText] = React.useState("Rozłączony");
  const [espStatus, setEspStatus] = React.useState("—");
  const [username, setUsername] = React.useState("fsrmag");
  const [password, setPassword] = React.useState("");

  const [state, setState] = React.useState<EspState>({});

  const [uiMode, setUiMode] = React.useState<"manual" | "pulse">("manual");
  const [manualPct, setManualPct] = React.useState(0);
  const draggingRef = React.useRef(false);
  const [pulseWave, setPulseWave] = React.useState<"sine" | "square">("sine");
  const [pulseHz, setPulseHz] = React.useState("2");
  const [pulseAmp, setPulseAmp] = React.useState("60");
  const [helpOpen, setHelpOpen] = React.useState(false);

  // === NOWY SILNIK WYKRESU (Real-Time Buffer) ===
  const pointsBufferRef = React.useRef<Point[]>([]);
  const bufferStartRef = React.useRef(0); // „początek” okna w buforze (bez kosztownego filter/shift)
  const chartTimerRef = React.useRef<number | null>(null);
  const pendingChartUpdateRef = React.useRef(false);

  const [viewData, setViewData] = React.useState<Point[]>([]);

  // Downsampling that preserves edges for square wave (prevents apparent phase shift)
  function downsampleWindow(windowData: Point[], maxPoints: number): Point[] {
    if (windowData.length <= maxPoints) return windowData;

    // Always keep transition points (magnet changes) + first/last
    const kept: Point[] = [];
    kept.push(windowData[0]);
    for (let i = 1; i < windowData.length; i++) {
      const prev = windowData[i - 1];
      const cur = windowData[i];
      if (cur.magnet !== prev.magnet) kept.push(cur);
    }
    const last = windowData[windowData.length - 1];
    if (kept[kept.length - 1].t !== last.t) kept.push(last);

    // If keeping edges is already enough, return them (stable edges > uniform sampling)
    if (kept.length >= maxPoints) {
      const step = Math.ceil(kept.length / maxPoints);
      const out: Point[] = [];
      for (let i = 0; i < kept.length; i += step) out.push(kept[i]);
      if (out[out.length - 1].t !== last.t) out.push(last);
      return out;
    }

    // Otherwise fill remaining budget with uniform sampling from the full window
    const remaining = maxPoints - kept.length;
    const step = Math.ceil(windowData.length / Math.max(1, remaining));
    const out: Point[] = [...kept];
    for (let i = 0; i < windowData.length; i += step) {
      out.push(windowData[i]);
      if (out.length >= maxPoints) break;
    }

    // Deduplicate by timestamp and sort
    const map = new Map<number, Point>();
    for (const p of out) map.set(p.t, p);
    const merged = Array.from(map.values()).sort((a, b) => a.t - b.t);

    const mergedLast = merged[merged.length - 1];
    if (mergedLast.t !== last.t) merged.push(last);
    return merged;
  }

  const computeAndSetViewData = React.useCallback(() => {
    const buf = pointsBufferRef.current;
    if (!buf.length) {
      setViewData([]);
      return;
    }

    const latestT = buf[buf.length - 1].t;
    const cutoff = latestT - WINDOW_MS;

    let start = bufferStartRef.current;
    while (start < buf.length && buf[start].t < cutoff) start++;
    bufferStartRef.current = start;

    if (start > 2000 && start > buf.length / 2) {
      pointsBufferRef.current = buf.slice(start);
      bufferStartRef.current = 0;
    }

    const s = bufferStartRef.current;
    const windowData = pointsBufferRef.current.slice(s);
    setViewData(downsampleWindow(windowData, MAX_VIEW_POINTS));
  }, []);

  const requestChartUpdate = React.useCallback(() => {
    pendingChartUpdateRef.current = true;
  }, []);

  // Sprzątanie timerów i throttlera przy unmount
  React.useEffect(() => {
    return () => {
      if (chartTimerRef.current !== null) {
        window.clearInterval(chartTimerRef.current);
        chartTimerRef.current = null;
      }
      if (uiUpdateTimerRef.current !== null) {
        window.clearTimeout(uiUpdateTimerRef.current);
        uiUpdateTimerRef.current = null;
      }
      clientRef.current?.end(true);
      clientRef.current = null;
    };
  }, []);

  // Timer effect to update chart at a fixed rate
  React.useEffect(() => {
    // Update the chart at a fixed rate (e.g. 10 Hz) to avoid re-rendering on every MQTT packet.
    if (chartTimerRef.current !== null) {
      window.clearInterval(chartTimerRef.current);
      chartTimerRef.current = null;
    }

    chartTimerRef.current = window.setInterval(() => {
      if (!pendingChartUpdateRef.current) return;
      pendingChartUpdateRef.current = false;
      computeAndSetViewData();
    }, 100); // 10 Hz (wystarcza dla podglądu, odciąża UI)

    return () => {
      if (chartTimerRef.current !== null) {
        window.clearInterval(chartTimerRef.current);
        chartTimerRef.current = null;
      }
    };
  }, [computeAndSetViewData]);

  const sendCmd = React.useCallback(
    (cmd: string) => {
      const c = clientRef.current;
      if (!c || !connected) return;
      c.publish(topics.cmd, cmd.endsWith("\n") ? cmd : cmd + "\n", {
        qos: 0,
        retain: false,
      });
    },
    [connected, topics.cmd],
  );

  const connect = () => {
    // If a previous client exists (e.g., user pressed connect again), close it first.
    if (clientRef.current) {
      try {
        clientRef.current.end(true);
      } catch {
        /* ignore */
      }
      clientRef.current = null;
    }

    setStatusText("Łączenie…");

    const c = mqtt.connect(BROKER_URL, {
      username: username,
      password: password,
      // Make the session identifiable and avoid clientId collisions
      clientId: `web-${DEVICE_ID}-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 2000,
      connectTimeout: 10_000,
      // Keepalive helps keep WS connections stable across mobile networks
      keepalive: 30,
      clean: true,
    });

    clientRef.current = c;

    c.on("connect", () => {
      setConnected(true);
      setStatusText("Połączony");
      c.subscribe([topics.state, topics.status], (err) => {
        if (err) {
          console.error("MQTT subscribe error:", err);
          setStatusText(
            `Błąd subskrypcji: ${(err as any)?.message ?? String(err)}`,
          );
        }
      });
      // Optional connectivity check for the ESP-side command handler
      c.publish(topics.cmd, "PING\n");
    });

    c.on("reconnect", () => setStatusText("Ponowne łączenie…"));

    c.on("offline", () => {
      console.warn("MQTT offline");
      setStatusText("Offline");
    });

    c.on("error", (err) => {
      console.error("MQTT error:", err);
      setStatusText(`Błąd MQTT: ${(err as any)?.message ?? String(err)}`);
    });

    c.on("close", () => {
      setConnected(false);
      setStatusText("Rozłączony");
    });

    c.on("end", () => {
      setConnected(false);
      setStatusText("Zakończono");
    });

    c.on("message", (topic, payload) => {
      const txt = payload.toString();

      if (topic === topics.status) {
        setEspStatus(txt);
        return;
      }

      if (topic === topics.state) {
        try {
          const obj = JSON.parse(txt) as EspState;

          // Store latest state and update UI on a throttled cadence
          lastStateRef.current = obj;
          scheduleUiUpdate();

          // Prefer ESP timestamp (millis) to eliminate network jitter on the X axis.
          // Compute a stable offset once per session.
          const espT = typeof obj.t_ms === "number" ? obj.t_ms : null;
          if (espT !== null && espTimeOffsetMsRef.current === null) {
            espTimeOffsetMsRef.current = Date.now() - espT;
          }
          const t =
            espT !== null && espTimeOffsetMsRef.current !== null
              ? espT + espTimeOffsetMsRef.current
              : Date.now();

          // Wykryj zmianę trybu (zachowane dla kompatybilności, ale dla PULSE i tak preferujemy magOutPct z ESP)
          const modeNow = obj.mode ?? 0;
          if (lastModeRef.current !== modeNow) {
            if (modeNow === 1) {
              pulseStartMsRef.current = t;
            } else {
              pulseStartMsRef.current = null;
            }
            lastModeRef.current = modeNow;
          }

          const pressureN = gramsToNewtons(Number(obj.g ?? 0));
          // This will use obj.magOutPct when provided by ESP (no unwanted phase shift)
          const magnet = estimateMagnetPct(obj, t, pulseStartMsRef.current);

          // PUSH do bufora - bez renderowania tutaj!
          pointsBufferRef.current.push({ t, pressure: pressureN, magnet });

          // Hard cap buffer to prevent long-session memory growth
          const MAX_BUF = 20_000;
          const buf = pointsBufferRef.current;
          if (buf.length > MAX_BUF) {
            // Keep the newest samples; adjust window start accordingly
            const drop = buf.length - MAX_BUF;
            pointsBufferRef.current = buf.slice(drop);
            bufferStartRef.current = Math.max(0, bufferStartRef.current - drop);
          }

          // Zgłoś potrzebę aktualizacji wykresu (wykres odświeża się z ustaloną częstotliwością)
          requestChartUpdate();
        } catch {
          /* ignore */
        }
      }
    });
  };

  const logout = () => {
    if (chartTimerRef.current !== null) {
      window.clearInterval(chartTimerRef.current);
      chartTimerRef.current = null;
    }
    if (uiUpdateTimerRef.current !== null) {
      window.clearTimeout(uiUpdateTimerRef.current);
      uiUpdateTimerRef.current = null;
    }
    clientRef.current?.end(true);
    clientRef.current = null;
    // Clear pulse phase alignment refs on logout
    pulseStartMsRef.current = null;
    lastModeRef.current = null;
    espTimeOffsetMsRef.current = null;
    setConnected(false);
    setStatusText("Rozłączony");
  };

  React.useEffect(() => {
    return () => {
      if (chartTimerRef.current !== null) {
        window.clearInterval(chartTimerRef.current);
        chartTimerRef.current = null;
      }
      if (uiUpdateTimerRef.current !== null) {
        window.clearTimeout(uiUpdateTimerRef.current);
        uiUpdateTimerRef.current = null;
      }
      // Clear pulse phase alignment refs on unmount
      pulseStartMsRef.current = null;
      lastModeRef.current = null;
      espTimeOffsetMsRef.current = null;
      clientRef.current?.end(true);
      clientRef.current = null;
    };
  }, []);

  const applyManual = (pct: number) => {
    const p = clamp(Math.round(pct), 0, 100);
    sendCmd(`M ${p}`);
  };

  const applyPulse = () => {
    const hz = Math.max(0.01, Number(pulseHz || "0"));
    const amp = clamp(Math.round(Number(pulseAmp || "0")), 0, 100);
    sendCmd(pulseWave === "sine" ? `P ${hz} ${amp}` : `Q ${hz} ${amp}`);
  };

  const stop = () => {
    // Wymuś natychmiastowe wyzerowanie wyjścia magnesu
    // (na wypadek gdyby samo STOP nie ustawiał wyjścia na 0 po stronie ESP)
    sendCmd("STOP");
    sendCmd("M 0");

    // Optymistycznie aktualizuj UI (stan z ESP i tak nadpisze to po chwili)
    setManualPct(0);
  };

  // Ostatnie wartości do liczników
  const currentMag = viewData.length ? viewData[viewData.length - 1].magnet : 0;
  const currentN = viewData.length ? viewData[viewData.length - 1].pressure : 0;

  if (!connected) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 text-foreground">
        <Card className="w-full max-w-md shadow-xl border-slate-200">
          <CardHeader className="text-center pb-2">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
              <div className="h-6 w-6 rounded-full bg-slate-900" />
            </div>
            <CardTitle className="text-xl">FSR Magnet</CardTitle>
            <CardDescription>{BROKER_URL}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs uppercase text-muted-foreground tracking-wider">
                  Użytkownik
                </Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-slate-50"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs uppercase text-muted-foreground tracking-wider">
                  Hasło
                </Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-slate-50"
                />
              </div>
            </div>
            <Button className="w-full mt-2" onClick={connect} size="lg">
              Połącz
            </Button>
            <div className="text-center text-xs text-muted-foreground pt-2">
              {statusText}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Obliczamy dynamiczne okno czasu dla osi X (podążamy za najnowszą próbką)
  const domainMax = viewData.length
    ? viewData[viewData.length - 1].t
    : Date.now();
  const domainMin = domainMax - WINDOW_MS;

  return (
    <div className="min-h-screen bg-slate-50/50 text-slate-900 p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        {/* Header */}
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between rounded-xl bg-white p-4 shadow-sm border border-slate-100">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-slate-900 flex items-center justify-center text-white font-bold">
              FS
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight tracking-tight">
                Panel Sterowania
              </h1>
              <div className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                ID: {DEVICE_ID}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusDot active={connected} label="MQTT" />
            <StatusDot active={espStatus === "online"} label="ESP" />
            <div className="h-6 w-px bg-slate-200 mx-1 hidden md:block" />
            <div className="flex items-center gap-2 bg-slate-100 px-3 py-1 rounded-md text-xs font-mono font-medium">
              MODE: {modeLabel(state.mode)}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground hover:text-red-600"
              onClick={logout}
            >
              Wyloguj
            </Button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[380px_1fr] items-start">
          {/* LEWA KOLUMNA - STEROWANIE */}
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <Card
                className="border-l-4 shadow-sm overflow-hidden relative"
                style={{ borderLeftColor: COLOR_PRESS }}
              >
                <CardContent className="p-4">
                  <div className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">
                    Nacisk
                  </div>
                  <div className="text-3xl font-bold tabular-nums tracking-tighter text-slate-900">
                    {currentN.toFixed(3)}{" "}
                    <span className="text-base font-normal text-muted-foreground">
                      N
                    </span>
                  </div>
                </CardContent>
              </Card>
              <Card
                className="border-l-4 shadow-sm overflow-hidden relative"
                style={{ borderLeftColor: COLOR_MAGNET }}
              >
                <CardContent className="p-4">
                  <div className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">
                    Magnes
                  </div>
                  <div className="text-3xl font-bold tabular-nums tracking-tighter text-slate-900">
                    {Math.round(currentMag)}{" "}
                    <span className="text-base font-normal text-muted-foreground">
                      %
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="shadow-sm border-slate-200">
              <CardHeader className="pb-3 border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-semibold">
                    Konfiguracja
                  </CardTitle>
                  <div className="w-[140px]">
                    <Select
                      value={uiMode}
                      onValueChange={(v) => setUiMode(v as any)}
                      disabled={!connected}
                    >
                      <SelectTrigger className="h-8 bg-white text-xs font-medium">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual">MANUAL</SelectItem>
                        <SelectItem value="pulse">PULSE</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5 space-y-6">
                {uiMode === "manual" && (
                  <div className="space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="space-y-4">
                      <div className="flex items-end justify-between">
                        <Label className="text-xs uppercase text-muted-foreground">
                          Moc wyjściowa
                        </Label>
                        <div className="text-2xl font-mono font-bold text-violet-600">
                          {manualPct}%
                        </div>
                      </div>
                      <Slider
                        className="py-2 cursor-pointer"
                        value={[manualPct]}
                        min={0}
                        max={100}
                        step={1}
                        disabled={!connected}
                        onPointerDownCapture={() => {
                          draggingRef.current = true;
                        }}
                        onPointerUpCapture={() => {
                          draggingRef.current = false;
                        }}
                        onPointerCancelCapture={() => {
                          draggingRef.current = false;
                        }}
                        onValueChange={(v) => {
                          setManualPct(v[0] ?? 0);
                        }}
                        onValueCommit={(v) => {
                          const pct = v[0] ?? 0;
                          draggingRef.current = false;
                          applyManual(pct);
                        }}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Input
                        className="font-mono text-center text-lg h-10 w-24"
                        inputMode="numeric"
                        value={String(manualPct)}
                        onChange={(e) =>
                          setManualPct(
                            clamp(Number(e.target.value || "0"), 0, 100),
                          )
                        }
                        disabled={!connected}
                      />
                      <Button
                        className="flex-1 bg-slate-900 hover:bg-slate-800 h-10"
                        onClick={() => applyManual(manualPct)}
                        disabled={!connected}
                      >
                        Ustaw
                      </Button>
                    </div>
                  </div>
                )}
                {uiMode === "pulse" && (
                  <div className="space-y-5 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        Rodzaj fali
                      </Label>
                      <Select
                        value={pulseWave}
                        onValueChange={(v) => setPulseWave(v as any)}
                        disabled={!connected}
                      >
                        <SelectTrigger className="bg-slate-50">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sine">Sinusoida (SINE)</SelectItem>
                          <SelectItem value="square">
                            Prostokąt (SQUARE)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          Amp (%)
                        </Label>
                        <Input
                          className="font-mono"
                          inputMode="numeric"
                          value={pulseAmp}
                          onChange={(e) => setPulseAmp(e.target.value)}
                          disabled={!connected}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          Hz
                        </Label>
                        <Input
                          className="font-mono"
                          inputMode="decimal"
                          value={pulseHz}
                          onChange={(e) => setPulseHz(e.target.value)}
                          disabled={!connected}
                        />
                      </div>
                    </div>
                    <Button
                      className="w-full bg-slate-900 hover:bg-slate-800"
                      onClick={applyPulse}
                      disabled={!connected}
                    >
                      START PULSE
                    </Button>
                  </div>
                )}
                <Separator />
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant="destructive"
                    onClick={stop}
                    disabled={!connected}
                    className="shadow-red-100 shadow-lg hover:bg-red-600"
                  >
                    STOP
                  </Button>
                  <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" disabled={!connected}>
                        HELP
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-lg">
                      <DialogHeader>
                        <DialogTitle>Instrukcja sterowania</DialogTitle>
                        <DialogDescription>
                          Najważniejsze informacje o trybach i komendach.
                        </DialogDescription>
                      </DialogHeader>

                      <div className="space-y-4 text-sm leading-relaxed">
                        <div className="space-y-1">
                          <div className="font-semibold">Tryby pracy</div>
                          <ul className="list-disc pl-5 space-y-1">
                            <li>
                              <span className="font-medium">MANUAL</span> —
                              ręczne ustawienie mocy magnesu (0–100%).
                            </li>
                            <li>
                              <span className="font-medium">PULSE</span> —
                              generowanie fali (SINE lub SQUARE) z parametrami
                              Hz i amplitudą.
                            </li>
                            <li>
                              <span className="font-medium">TRACK</span> —
                              sterowanie zależne od nacisku (g) i nastaw.
                            </li>
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <div className="font-semibold">Przyciski</div>
                          <ul className="list-disc pl-5 space-y-1">
                            <li>
                              <span className="font-medium">Ustaw</span> —
                              wysyła ustawioną wartość (MANUAL).
                            </li>
                            <li>
                              <span className="font-medium">START PULSE</span> —
                              uruchamia PULSE z bieżącymi parametrami.
                            </li>
                            <li>
                              <span className="font-medium">STOP</span> —
                              natychmiast zeruje elektromagnes (wysyła STOP i M
                              0).
                            </li>
                          </ul>
                        </div>

                        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                          <div className="font-semibold mb-1">Wskazówka</div>
                          <div className="text-muted-foreground">
                            Jeżeli urządzenie nie reaguje, sprawdź status
                            MQTT/ESP w nagłówku oraz poprawność ID urządzenia.
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          onClick={() => setHelpOpen(false)}
                        >
                          Zamknij
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* PRAWA KOLUMNA - WYKRES */}
          <Card className="h-full min-h-[500px] flex flex-col shadow-sm border-slate-200">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-slate-50">
              <div className="space-y-1">
                <CardTitle className="text-base flex items-center gap-2">
                  Monitor Live{" "}
                  <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                </CardTitle>
                <div className="text-xs text-muted-foreground">
                  Okno: {WINDOW_MS / 1000}s
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs font-medium">
                <div className="flex items-center gap-1.5 text-emerald-600">
                  <div className="h-2 w-4 rounded-full bg-emerald-500" /> Nacisk
                </div>
                <div className="flex items-center gap-1.5 text-violet-600">
                  <div className="h-2 w-4 rounded-full bg-violet-500" /> Magnes
                </div>
              </div>
            </CardHeader>

            <CardContent className="flex-1 p-0">
              <div className="h-[500px] w-full">
                <ResponsiveContainer width="99%" height="100%">
                  <LineChart
                    data={viewData}
                    margin={{ top: 20, right: 10, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      stroke="#f1f5f9"
                      strokeDasharray="3 3"
                      vertical={false}
                    />

                    {/* DYNAMICZNA OŚ X */}
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={[domainMin, domainMax]} // Klucz do płynnego ruchu
                      tick={false}
                      axisLine={false}
                      allowDataOverflow={false}
                    />

                    <YAxis
                      yAxisId="left"
                      orientation="left"
                      domain={[0, "auto"]}
                      tick={{ fontSize: 10, fill: "#16a34a" }}
                      width={40}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      domain={[0, 100]}
                      tick={{ fontSize: 10, fill: "#7c3aed" }}
                      width={40}
                      axisLine={false}
                      tickLine={false}
                    />

                    <Tooltip
                      isAnimationActive={false}
                      contentStyle={{
                        borderRadius: "8px",
                        border: "none",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                        fontSize: "12px",
                      }}
                      labelFormatter={(label) => formatClock(Number(label))}
                      formatter={(value, name) => {
                        if (name === "pressure")
                          return [
                            <span style={{ color: COLOR_PRESS }}>
                              {Number(value).toFixed(3)} N
                            </span>,
                            "Nacisk",
                          ];
                        if (name === "magnet")
                          return [
                            <span style={{ color: COLOR_MAGNET }}>
                              {Math.round(Number(value))}%
                            </span>,
                            "Magnes",
                          ];
                        return [value, name];
                      }}
                    />

                    <Line
                      yAxisId="left"
                      type="linear"
                      dataKey="pressure"
                      dot={false}
                      stroke={COLOR_PRESS}
                      strokeWidth={2}
                      isAnimationActive={false} // Wyłączenie animacji przy każdym renderze = płynność
                    />
                    <Line
                      yAxisId="right"
                      type="linear"
                      dataKey="magnet"
                      dot={false}
                      stroke={COLOR_MAGNET}
                      strokeWidth={2}
                      strokeOpacity={0.7}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
