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

export const Route = createFileRoute("/control")({
  component: Dashboard,
});

// ===================== CONFIG =====================
const BROKER_URL = "wss://mechanical-fey-spliff-ed1ace61.koyeb.app";
const DEVICE_ID = "3C893E124B00";
const TOPIC_BASE = "fsrmag";

const COLOR_MAGNET = "#7C3AED"; // fiolet
const COLOR_PRESS = "#22C55E"; // zielony
const WINDOW_MS = 30_000; // Okno czasu: 30 sekund
const REFRESH_RATE_MS = 40; // Odświeżanie wykresu co 40ms (25 FPS)

type EspState = {
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

function estimateMagnetPct(state: EspState, nowMs: number) {
  if (typeof state.magOutPct === "number")
    return clamp(state.magOutPct, 0, 100);
  const mode = state.mode ?? 0;
  if (mode === 0) return clamp(state.manual ?? 0, 0, 100);
  if (mode === 2) {
    const g = state.g ?? 0;
    const target = state.trackTarget ?? 0;
    const kp = state.trackKp ?? 0;
    const maxPct = state.trackMax ?? 100;
    return clamp(Math.round(kp * (target - g)), 0, maxPct);
  }
  const hz = Math.max(0.01, state.pulseHz ?? 1);
  const amp = clamp(state.pulseAmp ?? 0, 0, 100);
  const wave = state.pulseWave ?? 0;
  const tSec = nowMs / 1000;
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

  // === NOWY SILNIK WYKRESU (Real-Time Buffer) ===
  const pointsBufferRef = React.useRef<Point[]>([]);
  const [viewData, setViewData] = React.useState<Point[]>([]);
  const [now, setNow] = React.useState(Date.now()); // Potrzebne do przesuwania osi X

  // Główna pętla odświeżania (Game Loop)
  React.useEffect(() => {
    const interval = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow); // To wymusi przesunięcie osi X (Domain)

      const cutoff = currentNow - WINDOW_MS;

      // 1. Usuń stare punkty (Garbage Collection)
      // Jeśli punkt jest starszy niż okno, wylatuje.
      if (
        pointsBufferRef.current.length > 0 &&
        pointsBufferRef.current[0].t < cutoff
      ) {
        // Filtrujemy tylko jeśli faktycznie coś jest starego, żeby nie mielić tablicy bez sensu
        pointsBufferRef.current = pointsBufferRef.current.filter(
          (p) => p.t >= cutoff
        );
      }

      // 2. Aktualizuj stan dla Recharts
      // Kopiujemy tablicę (płytka kopia jest szybka)
      setViewData([...pointsBufferRef.current]);
    }, REFRESH_RATE_MS);

    return () => clearInterval(interval);
  }, []);

  const sendCmd = React.useCallback(
    (cmd: string) => {
      const c = clientRef.current;
      if (!c || !connected) return;
      c.publish(topics.cmd, cmd.endsWith("\n") ? cmd : cmd + "\n");
    },
    [connected, topics.cmd]
  );

  const connect = () => {
    setStatusText("Łączenie…");
    const c = mqtt.connect(BROKER_URL, {
      username: username || undefined,
      password: password || undefined,
      reconnectPeriod: 2000,
    });
    clientRef.current = c;

    c.on("connect", () => {
      setConnected(true);
      setStatusText("Połączony");
      c.subscribe([topics.state, topics.status]);
      c.publish(topics.cmd, "PING");
    });

    c.on("reconnect", () => setStatusText("Ponowne łączenie…"));
    c.on("close", () => {
      setConnected(false);
      setStatusText("Rozłączony");
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
          setState(obj);

          if (
            !draggingRef.current &&
            (obj.mode ?? 0) === 0 &&
            typeof obj.manual === "number"
          ) {
            setManualPct(obj.manual);
          }

          const t = Date.now();
          const pressure = Number(obj.g ?? 0);
          const magnet = estimateMagnetPct(obj, t);

          // PUSH do bufora - bez renderowania tutaj!
          pointsBufferRef.current.push({ t, pressure, magnet });
        } catch {
          /* ignore */
        }
      }
    });
  };

  const logout = () => {
    clientRef.current?.end(true);
    clientRef.current = null;
    setConnected(false);
    setStatusText("Rozłączony");
  };

  React.useEffect(() => {
    return () => {
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

  const stop = () => sendCmd("STOP");

  // Ostatnie wartości do liczników
  const currentMag = viewData.length ? viewData[viewData.length - 1].magnet : 0;
  const currentG = typeof state.g === "number" ? state.g : 0;

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

  // Obliczamy dynamiczne okno czasu dla osi X
  const domainMin = now - WINDOW_MS;
  const domainMax = now;

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
                    {currentG.toFixed(1)}{" "}
                    <span className="text-base font-normal text-muted-foreground">
                      g
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
                            clamp(Number(e.target.value || "0"), 0, 100)
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
                  <Button
                    variant="outline"
                    onClick={() => sendCmd("H")}
                    disabled={!connected}
                  >
                    HELP
                  </Button>
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
                              {Number(value).toFixed(1)} g
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
                      type="monotone"
                      dataKey="pressure"
                      dot={false}
                      stroke={COLOR_PRESS}
                      strokeWidth={2}
                      isAnimationActive={false} // Wyłączenie animacji przy każdym renderze = płynność
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
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
