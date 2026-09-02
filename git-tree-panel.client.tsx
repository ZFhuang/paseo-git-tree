import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  commitDetail,
  commitDiff,
  computeGraph,
  gitBranchOp,
  gitTree,
  type CommitDetailOutput,
  type TreeScope,
  type CommitDiffOutput,
  type GitBranchOp,
  type GitTreeOutput,
  type GitTreeRow,
} from "./git-tree.shared";

// --- Geometry ---------------------------------------------------------------

const ROW_HEIGHT = 40;
const LANE_WIDTH = 14;
/** Gap between commit cards; lane lines run through it. */
const CARD_GAP = 6;
const CARD_RADIUS = 8;
const CARD_BORDER = 1;
const DOT_R = 4;
const LINE_W = 2;
const GRAPH_PAD_X = 8;
/** Breathing room between the last lane and the commit text. */
const GRAPH_PAD_RIGHT = 6;
/** Collapsed row: header + card border + inter-card gap. */
const COLLAPSED_ROW_H = ROW_HEIGHT + CARD_BORDER * 2 + CARD_GAP;
const LIST_OVERSCAN = 18;
const LIST_PAD_Y = 8;
const LIST_PAD_X = 8;
const COMMIT_LIMIT = 500;

function laneX(lane: number): number {
  return GRAPH_PAD_X + lane * LANE_WIDTH;
}

function graphWidth(laneCount: number): number {
  return GRAPH_PAD_X + Math.max(1, laneCount) * LANE_WIDTH + GRAPH_PAD_RIGHT;
}

function laneCountOf(rows: GitTreeRow[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.lane > max) max = row.lane;
    for (const e of row.edges) {
      if (e.from > max) max = e.from;
      if (e.to > max) max = e.to;
    }
  }
  return max + 1;
}

/** VS Code-like palette for lanes; cycles when a graph has many lanes. */
const LANE_COLORS = [
  "#4aa3ff", // blue
  "#8bc34a", // green
  "#ffb74d", // orange
  "#ba68c8", // purple
  "#4dd0e1", // cyan
  "#f06292", // pink
  "#aed581", // lime
  "#ff8a65", // coral
  "#9575cd", // violet
  "#ffd54f", // yellow
];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/** Stable FNV-1a so each branch name maps to a distinct palette slot. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function branchColor(name: string): string {
  return LANE_COLORS[hashString(name) % LANE_COLORS.length];
}

function withAlpha(hex: string, alpha: string): string {
  return hex.length === 7 ? hex + alpha : hex;
}

/** Compact relative age: `just now`, `3h`, `2d`, `1w`, `5mo`, `3y`. Weeks
 *  only cover 7–29 days; 30+ days collapse to months. */
function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.max(1, Math.floor(d / 365))}y`;
}

const FLOAT_SHADOW = {
  boxShadow: "0 8px 28px rgba(0,0,0,0.38), 0 1px 0 rgba(255,255,255,0.04)",
} as const;

async function copyToClipboard(text: string): Promise<boolean> {
  const g = globalThis as {
    navigator?: { clipboard?: { writeText: (value: string) => Promise<void> } };
    document?: {
      body: { appendChild(node: unknown): void; removeChild(node: unknown): void } | null;
      execCommand: (command: string) => boolean;
      createElement(tag: string): {
        value: string;
        style: { cssText: string };
        setAttribute(name: string, value: string): void;
        focus(): void;
        select(): void;
        setSelectionRange(start: number, end: number): void;
      };
    };
  };

  // execCommand still works inside plugin iframes that lack clipboard-write.
  // Must run in the click turn (user gesture).
  try {
    const doc = g.document;
    if (doc?.body) {
      const el = doc.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0";
      doc.body.appendChild(el);
      el.focus();
      el.select();
      el.setSelectionRange(0, text.length);
      const ok = doc.execCommand("copy");
      doc.body.removeChild(el);
      if (ok) return true;
    }
  } catch {
    // fall through to Clipboard API
  }

  try {
    const clip = g.navigator?.clipboard;
    if (clip && typeof clip.writeText === "function") {
      await clip.writeText(text);
      return true;
    }
  } catch {
    // no clipboard access
  }
  return false;
}

type WebContextMenuEvent = {
  preventDefault(): void;
  stopPropagation(): void;
  nativeEvent: { pageX: number; pageY: number };
};

/**
 * One segment between two points in the slice's local coordinate space.
 * Verticals are a plain View (no transform). Diagonals are a bar rotated
 * about its center — default RN origin — so endpoints land on the dots.
 */
function GraphSeg({
  x1,
  y1,
  x2,
  y2,
  color,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return null;

  if (Math.abs(dx) < 0.5) {
    const top = Math.min(y1, y2);
    return (
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: x1 - LINE_W / 2,
          top,
          width: LINE_W,
          height: Math.abs(dy),
          backgroundColor: color,
        }}
      />
    );
  }

  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (x1 + x2) / 2 - len / 2,
        top: (y1 + y2) / 2 - LINE_W / 2,
        width: len,
        height: LINE_W,
        backgroundColor: color,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

/**
 * Graph for a single commit row. Coordinates are local: y=0 is this
 * card's top, y=height is the next card's top (this card + inter-card gap).
 *
 * The commit dot is always at the header center. Through-lines span the
 * full height, so they stretch through expanded detail and the gap.
 */
function GraphSlice({
  row,
  prevRow,
  height,
  graphW,
}: {
  row: GitTreeRow;
  prevRow: GitTreeRow | undefined;
  height: number;
  graphW: number;
}) {
  const cy = CARD_BORDER + ROW_HEIGHT / 2;
  const bottom = Math.max(height, cy + DOT_R);

  const arrived = new Set<number>();
  if (prevRow) {
    for (const e of prevRow.edges) {
      if (!e.fromTop) arrived.add(e.to);
    }
  }
  for (const e of row.edges) {
    if (e.fromTop) arrived.add(e.from);
  }

  const segs: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; color: string }> = [];
  let ownThru = false;
  for (const edge of row.edges) {
    const color = laneColor(edge.from);
    if (edge.fromTop) {
      segs.push({
        key: `${edge.from}>${edge.to}@in`,
        x1: laneX(edge.from),
        y1: 0,
        x2: laneX(edge.to),
        y2: cy,
        color,
      });
    } else if (edge.from === edge.to) {
      if (edge.from === row.lane) ownThru = true;
      const x = laneX(edge.from);
      const startY = edge.from !== row.lane || arrived.has(edge.from) ? 0 : cy;
      segs.push({
        key: `${edge.from}>${edge.to}@thru`,
        x1: x,
        y1: startY,
        x2: x,
        y2: bottom,
        color,
      });
    } else {
      segs.push({
        key: `${edge.from}>${edge.to}@out`,
        x1: laneX(edge.from),
        y1: cy,
        x2: laneX(edge.to),
        y2: bottom,
        color,
      });
    }
  }
  // Merge/fork rows have no through-vertical on the commit lane, but a
  // parent row's line still arrives at y=0. Draw the missing 0→dot stub.
  if (arrived.has(row.lane) && !ownThru) {
    const x = laneX(row.lane);
    segs.push({
      key: `${row.lane}@in-stub`,
      x1: x,
      y1: 0,
      x2: x,
      y2: cy,
      color: laneColor(row.lane),
    });
  }

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: graphW,
        height: bottom,
        zIndex: 2,
      }}
    >
      {segs.map((s) => (
        <GraphSeg key={s.key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} color={s.color} />
      ))}
      <View
        style={{
          position: "absolute",
          left: laneX(row.lane) - DOT_R,
          top: cy - DOT_R,
          width: DOT_R * 2,
          height: DOT_R * 2,
          borderRadius: DOT_R,
          backgroundColor: laneColor(row.lane),
          borderWidth: 1,
          borderColor: "rgba(0,0,0,0.35)",
        }}
      />
    </View>
  );
}

type FloatColors = {
  fg: string;
  fgMuted: string;
  surface: string;
  ring: string;
  hover: string;
};

function CommitTip({
  x,
  y,
  row,
  colors,
}: {
  x: number;
  y: number;
  row: GitTreeRow;
  colors: FloatColors;
}) {
  const date = row.date ? row.date.replace("T", " ").slice(0, 19) : "";
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: x,
        top: y,
        maxWidth: 300,
        zIndex: 40,
        backgroundColor: colors.surface,
        borderRadius: CARD_RADIUS,
        borderWidth: 1,
        borderColor: colors.ring,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 6,
        ...FLOAT_SHADOW,
      }}
    >
      <Text style={{ color: colors.fg, fontSize: 12, lineHeight: 17 }}>{row.subject}</Text>
      <Text style={{ color: colors.fgMuted, fontSize: 10, fontFamily: "monospace" }}>
        {row.shortHash}
        {row.author ? `  ·  ${row.author}` : ""}
        {date ? `  ·  ${date}` : ""}
      </Text>
    </View>
  );
}

function MenuItem({
  label,
  hint,
  colors,
  onPress,
}: {
  label: string;
  hint: string;
  colors: FloatColors;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginHorizontal: 3,
        borderRadius: 6,
        backgroundColor: hovered ? colors.hover : "transparent",
        gap: 2,
      }}
    >
      <Text style={{ color: colors.fg, fontSize: 12 }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 10, fontFamily: "monospace" }}>
        {hint}
      </Text>
    </Pressable>
  );
}

function CommitMenu({
  x,
  y,
  row,
  colors,
  onCopy,
  onDismiss,
}: {
  x: number;
  y: number;
  row: GitTreeRow;
  colors: FloatColors;
  onCopy: (kind: "message" | "hash") => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <Pressable
        onPress={onDismiss}
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 41 }}
      />
      <View
        style={{
          position: "absolute",
          left: x,
          top: y,
          minWidth: 200,
          zIndex: 42,
          backgroundColor: colors.surface,
          borderRadius: CARD_RADIUS,
          borderWidth: 1,
          borderColor: colors.ring,
          paddingVertical: 4,
          ...FLOAT_SHADOW,
        }}
      >
        <MenuItem
          label="Copy commit message"
          hint={row.subject}
          colors={colors}
          onPress={() => onCopy("message")}
        />
        <MenuItem
          label="Copy commit hash"
          hint={row.shortHash}
          colors={colors}
          onPress={() => onCopy("hash")}
        />
      </View>
    </>
  );
}

type BranchHead = { name: string; hash: string; isCurrent: boolean };

function BranchNameRow({
  name,
  color,
  isCurrent,
  open,
  colors,
  onPress,
  children,
}: {
  name: string;
  color: string;
  isCurrent: boolean;
  open: boolean;
  colors: FloatColors;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <View>
      <Pressable
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: open || hovered ? colors.hover : "transparent",
        }}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: color,
          }}
        />
        <Text
          numberOfLines={1}
          style={{
            color: colors.fg,
            fontSize: 12,
            fontWeight: isCurrent ? "700" : "500",
            flex: 1,
            flexShrink: 1,
          }}
        >
          {name}
        </Text>
        {isCurrent ? (
          <Text style={{ color, fontSize: 10, fontWeight: "700" }}>current</Text>
        ) : null}
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={colors.fgMuted} />
      </Pressable>
      {children}
    </View>
  );
}

function BranchAction({
  label,
  hint,
  colors,
  danger,
  disabled,
  onPress,
}: {
  label: string;
  hint?: string;
  colors: FloatColors;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginHorizontal: 3,
        borderRadius: 6,
        backgroundColor: hovered && !disabled ? colors.hover : "transparent",
        opacity: disabled ? 0.45 : 1,
        gap: 1,
      }}
    >
      <Text style={{ color: danger ? "#f06292" : colors.fg, fontSize: 12 }}>{label}</Text>
      {hint ? (
        <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 10, fontFamily: "monospace" }}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function BranchMenu({
  x,
  y,
  heads,
  colors,
  busy,
  onDismiss,
  onOp,
}: {
  x: number;
  y: number;
  heads: BranchHead[];
  colors: FloatColors;
  busy: boolean;
  onDismiss: () => void;
  onOp: (op: GitBranchOp | "copy", name?: string) => void;
}) {
  const current = heads.find((h) => h.isCurrent);
  const sorted = useMemo(() => {
    const rest = heads.filter((h) => !h.isCurrent).slice().sort((a, b) => a.name.localeCompare(b.name));
    return current ? [current, ...rest] : rest;
  }, [heads, current]);

  const [openName, setOpenName] = useState<string | null>(current?.name ?? null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <>
      <Pressable
        onPress={onDismiss}
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 41 }}
      />
      <View
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: 260,
          maxHeight: 360,
          zIndex: 42,
          backgroundColor: colors.surface,
          borderRadius: CARD_RADIUS,
          borderWidth: 1,
          borderColor: colors.ring,
          paddingVertical: 4,
          ...FLOAT_SHADOW,
        }}
      >
        <ScrollView nestedScrollEnabled>
          <Pressable
            onPress={() => {
              setCreating((v) => !v);
              setOpenName(null);
              setConfirmDelete(null);
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Text style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>+ New branch</Text>
          </Pressable>
          {creating ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingBottom: 8 }}>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="branch-name"
                placeholderTextColor={colors.fgMuted}
                autoFocus
                editable={!busy}
                onSubmitEditing={() => {
                  const n = newName.trim();
                  if (n) onOp("create", n);
                }}
                style={{
                  flex: 1,
                  color: colors.fg,
                  fontSize: 12,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: colors.ring,
                  backgroundColor: "rgba(0,0,0,0.18)",
                }}
              />
              <Pressable
                onPress={() => {
                  const n = newName.trim();
                  if (n) onOp("create", n);
                }}
                disabled={busy || !newName.trim()}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: colors.hover,
                  opacity: busy || !newName.trim() ? 0.45 : 1,
                }}
              >
                <Text style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>Create</Text>
              </Pressable>
            </View>
          ) : null}

          {sorted.map((h) => {
            const color = branchColor(h.name);
            const open = openName === h.name;
            return (
              <BranchNameRow
                key={h.name}
                name={h.name}
                color={color}
                isCurrent={h.isCurrent}
                open={open}
                colors={colors}
                onPress={() => {
                  setOpenName(open ? null : h.name);
                  setConfirmDelete(null);
                  setCreating(false);
                }}
              >
                {open ? (
                  <View style={{ paddingBottom: 4 }}>
                    {h.isCurrent ? (
                      <BranchAction
                        label="Pull"
                        hint="git pull"
                        colors={colors}
                        disabled={busy}
                        onPress={() => onOp("pull")}
                      />
                    ) : (
                      <>
                        <BranchAction
                          label="Checkout"
                          hint={`git checkout ${h.name}`}
                          colors={colors}
                          disabled={busy}
                          onPress={() => onOp("checkout", h.name)}
                        />
                        <BranchAction
                          label={current ? `Merge into ${current.name}` : "Merge"}
                          hint={`git merge ${h.name}`}
                          colors={colors}
                          disabled={busy}
                          onPress={() => onOp("merge", h.name)}
                        />
                      </>
                    )}
                    <BranchAction
                      label="Copy name"
                      hint={h.name}
                      colors={colors}
                      disabled={busy}
                      onPress={() => onOp("copy", h.name)}
                    />
                    {!h.isCurrent ? (
                      <BranchAction
                        label={confirmDelete === h.name ? "Confirm delete" : "Delete branch"}
                        hint={confirmDelete === h.name ? "git branch -d  ·  cannot be undone" : `git branch -d ${h.name}`}
                        colors={colors}
                        danger
                        disabled={busy}
                        onPress={() => {
                          if (confirmDelete === h.name) onOp("delete", h.name);
                          else setConfirmDelete(h.name);
                        }}
                      />
                    ) : null}
                  </View>
                ) : null}
              </BranchNameRow>
            );
          })}
        </ScrollView>
      </View>
    </>
  );
}

// --- Diff rendering -----------------------------------------------------------

function DiffLine({
  text,
  colors,
}: {
  text: string;
  colors: { added: string; removed: string; fgMuted: string; fg: string };
}) {
  const kind =
    text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")
      ? "meta"
      : text.startsWith("@@")
        ? "hunk"
        : text.startsWith("+")
          ? "add"
          : text.startsWith("-")
            ? "del"
            : "ctx";
  const tint =
    kind === "add"
      ? { color: colors.added, backgroundColor: colors.added + "18" }
      : kind === "del"
        ? { color: colors.removed, backgroundColor: colors.removed + "18" }
        : kind === "hunk" || kind === "meta"
          ? { color: colors.fgMuted }
          : { color: colors.fgMuted };
  return (
    <Text
      style={{
        fontSize: 11,
        fontFamily: "monospace",
        lineHeight: 16,
        paddingHorizontal: 8,
        paddingVertical: 1,
        ...tint,
      }}
    >
      {text || " "}
    </Text>
  );
}

function InlineDiff({
  patch,
  loading,
  error,
  colors,
}: {
  patch: string | null;
  loading: boolean;
  error: string | null;
  colors: { added: string; removed: string; fgMuted: string; fg: string; sunkenBg: string; ring: string };
}) {
  if (loading) {
    return (
      <Text style={{ color: colors.fgMuted, fontSize: 12, paddingVertical: 8, paddingHorizontal: 8 }}>
        Loading diff…
      </Text>
    );
  }
  if (error) {
    return (
      <Text style={{ color: colors.removed, fontSize: 12, paddingVertical: 8, paddingHorizontal: 8 }}>{error}</Text>
    );
  }
  if (!patch) {
    return (
      <Text style={{ color: colors.fgMuted, fontSize: 12, paddingVertical: 8, paddingHorizontal: 8 }}>
        No changes in this file view.
      </Text>
    );
  }
  return (
    <View
      style={{
        marginTop: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.ring,
        backgroundColor: colors.sunkenBg,
        paddingVertical: 4,
        maxHeight: 320,
        overflow: "hidden",
      }}
    >
      <ScrollView nestedScrollEnabled>
        {patch.split("\n").map((line, i) => (
          <DiffLine key={i} text={line} colors={colors} />
        ))}
      </ScrollView>
    </View>
  );
}

// --- Inline commit expansion ---------------------------------------------------

function FileRow({
  file,
  expanded,
  colors,
  onToggle,
}: {
  file: CommitDetailOutput["files"][number];
  expanded: boolean;
  colors: { fg: string; fgMuted: string; added: string; removed: string; border: string; accent: string; hoverBg: string };
  onToggle: () => void;
}) {
  const statusLabel =
    file.status === "A" || file.status === "C"
      ? "A"
      : file.status === "D"
        ? "D"
        : file.status === "R"
          ? "R"
          : "M";
  const statusColor =
    file.status === "A" || file.status === "C"
      ? colors.added
      : file.status === "D"
        ? colors.removed
        : file.status === "R"
          ? colors.accent
          : colors.fgMuted;
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onToggle}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: hovered || expanded ? colors.hoverBg : "transparent",
      }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: statusColor + "22",
        }}
      >
        <Text style={{ color: statusColor, fontSize: 10, fontWeight: "700" }}>{statusLabel}</Text>
      </View>
      <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 12, flex: 1, flexShrink: 1 }}>
        {file.status === "R" && file.oldPath ? (
          <Text style={{ color: colors.fgMuted, fontSize: 12 }}>
            {file.oldPath}
            <Text style={{ color: colors.fgMuted }}> ⟶ </Text>
          </Text>
        ) : null}
        {file.path}
      </Text>
      <Text style={{ color: colors.added, fontSize: 11, fontFamily: "monospace" }}>+{file.additions}</Text>
      <Text style={{ color: colors.removed, fontSize: 11, fontFamily: "monospace" }}>−{file.deletions}</Text>
      <Icon
        name={expanded ? "ChevronDown" : "ChevronRight"}
        size={12}
        color={colors.fgMuted}
      />
    </Pressable>
  );
}

function MetaRow({
  label,
  children,
  colors,
}: {
  label: string;
  children: React.ReactNode;
  colors: { fgMuted: string };
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text
        style={{
          color: colors.fgMuted,
          fontSize: 10,
          fontWeight: "700",
          textTransform: "uppercase",
          width: 56,
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline", flexShrink: 1 }}>
        {children}
      </View>
    </View>
  );
}

function CommitExpansion({
  directory,
  hash,
  theme,
  expandedFile,
  onToggleFile,
  graphW,
}: {
  directory: string;
  hash: string;
  theme: PluginWorkspacePanelProps["theme"];
  expandedFile: string | null;
  onToggleFile: (path: string) => void;
  graphW: number;
}) {
  const getDetail = useRpc(commitDetail);
  const getDiff = useRpc(commitDiff);
  const [detail, setDetail] = useState<CommitDetailOutput | null>(null);
  const [diff, setDiff] = useState<CommitDiffOutput | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    getDetail({ directory, hash })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [directory, hash, getDetail]);

  useEffect(() => {
    if (!expandedFile) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    getDiff({ directory, hash, path: expandedFile })
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDiff({ patch: "", error: "Failed to load diff" });
      });
    return () => {
      cancelled = true;
    };
  }, [directory, hash, expandedFile, getDiff]);

  const colors = {
    fg: theme.colors.foreground,
    fgMuted: theme.colors.foregroundMuted,
    added: theme.colors.statusSuccess,
    removed: theme.colors.statusDanger,
    border: theme.colors.border,
    accent: theme.colors.accent,
    chipBg: theme.colors.surface1,
    hoverBg: theme.colors.surface2,
    sunkenBg: theme.colors.surface0,
    ring: theme.colors.border + "40",
  };

  if (!detail) {
    return (
      <Text style={{ color: colors.fgMuted, fontSize: 12, paddingVertical: 10, paddingRight: 10, marginLeft: graphW }}>
        Loading…
      </Text>
    );
  }
  if (detail.error) {
    return (
      <Text style={{ color: colors.removed, fontSize: 12, paddingVertical: 10, paddingRight: 10, marginLeft: graphW }}>
        {detail.error}
      </Text>
    );
  }

  return (
    <View
      style={{
        marginLeft: graphW,
        paddingTop: 8,
        paddingBottom: 12,
        paddingRight: 12,
        gap: 10,
      }}
    >
      <View style={{ gap: 4 }}>
        <MetaRow label="Author" colors={colors}>
          <Text style={{ color: colors.fg, fontSize: 12 }}>{detail.author}</Text>
          <Text style={{ color: colors.fgMuted, fontSize: 11 }}> &lt;{detail.email}&gt;</Text>
        </MetaRow>
        <MetaRow label="Date" colors={colors}>
          <Text style={{ color: colors.fg, fontSize: 12, fontFamily: "monospace" }}>
            {detail.date.replace("T", " ").slice(0, 19)}
          </Text>
        </MetaRow>
        <MetaRow label="Parents" colors={colors}>
          <Text style={{ color: colors.fg, fontSize: 12, fontFamily: "monospace" }}>
            {detail.parents.map((p) => p.slice(0, 7)).join(", ") || "(root)"}
          </Text>
        </MetaRow>
      </View>

      {detail.body ? (
        <Text style={{ color: colors.fgMuted, fontSize: 12, lineHeight: 18 }}>
          {detail.body}
        </Text>
      ) : null}

      {/* Files live in a sunken surface so the section reads as its own block. */}
      <View
        style={{
          backgroundColor: colors.sunkenBg,
          borderRadius: CARD_RADIUS,
          borderWidth: 1,
          borderColor: colors.ring,
          paddingVertical: 4,
          paddingHorizontal: 4,
          gap: 2,
        }}
      >
        <View style={{ paddingHorizontal: 4, paddingBottom: 2 }}>
          <Text
            style={{
              color: colors.fgMuted,
              fontSize: 10,
              fontWeight: "700",
              textTransform: "uppercase",
            }}
          >
            {detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed
          </Text>
        </View>
        {detail.files.map((file) => (
          <View key={file.path}>
            <FileRow
              file={file}
              colors={colors}
              expanded={expandedFile === file.path}
              onToggle={() => onToggleFile(file.path)}
            />
            {expandedFile === file.path ? (
              <InlineDiff
                patch={diff && !diff.error ? diff.patch : null}
                loading={diff === null}
                error={diff?.error ?? null}
                colors={colors}
              />
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

// --- Commit list row -----------------------------------------------------------

type RowColors = {
  fg: string;
  fgMuted: string;
  success: string;
  chipBg: string;
  selected: string;
  hoverBg: string;
  expandedBg: string;
  hairline: string;
  ring: string;
  cardBg: string;
};

const CommitRow = memo(function CommitRow({
  row,
  prevRow,
  index,
  graphW,
  colors,
  compact,
  expanded,
  expandedFile,
  onToggle,
  onToggleFile,
  directory,
  theme,
  onOpenMenu,
  onShowTip,
  onHideTip,
  onHeight,
}: {
  row: GitTreeRow;
  prevRow: GitTreeRow | undefined;
  index: number;
  graphW: number;
  colors: RowColors;
  compact: boolean;
  expanded: boolean;
  expandedFile: string | null;
  onToggle: (hash: string) => void;
  onToggleFile: (path: string) => void;
  directory: string;
  theme: PluginWorkspacePanelProps["theme"];
  onOpenMenu: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onShowTip: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onHideTip: () => void;
  onHeight: (index: number, height: number) => void;
}) {
  const cardRef = useRef<View>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sliceH, setSliceH] = useState(COLLAPSED_ROW_H);

  useEffect(
    () => () => {
      if (tipTimer.current) clearTimeout(tipTimer.current);
    },
    [],
  );

  const headRef = row.refs.find((r) => r.startsWith("HEAD ->"));
  const headBranch = headRef ? headRef.slice("HEAD -> ".length) : null;
  const branchRefs = row.refs.filter(
    (r) => !r.startsWith("HEAD ->") && r !== "HEAD" && !r.startsWith("tag:"),
  );
  const shownBranches = headBranch
    ? [headBranch, ...branchRefs.filter((r) => r !== headBranch)]
    : branchRefs;
  const tags = row.refs.filter((r) => r.startsWith("tag:")).map((t) => t.slice(5));
  const isHead = headRef !== undefined || row.refs.includes("HEAD");
  const [hovered, setHovered] = useState(false);

  const rowBg = expanded ? colors.expandedBg : hovered ? colors.hoverBg : colors.cardBg;

  const clearTipTimer = () => {
    if (tipTimer.current) {
      clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
  };

  const scheduleTip = () => {
    clearTipTimer();
    tipTimer.current = setTimeout(() => {
      cardRef.current?.measureInWindow((x, y, w, h) => {
        onShowTip(row, x + Math.min(w * 0.35, 140), y + h + 6);
      });
    }, 380);
  };

  const openMenu = (pageX: number, pageY: number) => {
    clearTipTimer();
    onHideTip();
    onOpenMenu(row, pageX, pageY);
  };

  return (
    <View
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h <= 0) return;
        setSliceH(h);
        onHeight(index, h);
      }}
      style={{ overflow: "visible" }}
    >
      <View
        ref={cardRef}
        style={{
          backgroundColor: rowBg,
          borderRadius: CARD_RADIUS,
          borderWidth: CARD_BORDER,
          borderColor: colors.ring,
          overflow: "hidden",
          boxShadow: "0 1px 2px rgba(0,0,0,0.14)",
        }}
      >
      <Pressable
        onPress={() => onToggle(row.hash)}
        onHoverIn={() => {
          setHovered(true);
          scheduleTip();
        }}
        onHoverOut={() => {
          setHovered(false);
          clearTipTimer();
          onHideTip();
        }}
        onLongPress={(e) => openMenu(e.nativeEvent.pageX, e.nativeEvent.pageY)}
        {...({
          onContextMenu: (e: WebContextMenuEvent) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.nativeEvent.pageX, e.nativeEvent.pageY);
          },
        } as object)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: ROW_HEIGHT,
          paddingLeft: graphW,
          paddingRight: compact ? 10 : 14,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            {shownBranches.slice(0, 2).map((ref) => {
              const tint = branchColor(ref);
              return (
                <View
                  key={ref}
                  style={{
                    backgroundColor: withAlpha(tint, "28"),
                    borderRadius: 4,
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                    borderWidth: 1,
                    borderColor: withAlpha(tint, "99"),
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 10, color: tint, fontWeight: headBranch === ref ? "700" : "500" }}
                  >
                    {ref}
                  </Text>
                </View>
              );
            })}
            {tags.slice(0, 1).map((tag) => (
              <View
                key={tag}
                style={{
                  backgroundColor: colors.chipBg,
                  borderRadius: 4,
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderWidth: 1,
                  borderColor: colors.ring,
                }}
              >
                <Text numberOfLines={1} style={{ fontSize: 10, color: colors.fgMuted }}>
                  {tag}
                </Text>
              </View>
            ))}
            <Text
              numberOfLines={1}
              style={{
                color: colors.fg,
                fontSize: 13,
                fontWeight: isHead ? "600" : "400",
                flexShrink: 1,
              }}
            >
              {row.subject}
            </Text>
            <Icon
              name={expanded ? "ChevronDown" : "ChevronRight"}
              size={12}
              color={colors.fgMuted}
            />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              style={{
                color: colors.fgMuted,
                fontSize: 10,
                fontFamily: "monospace",
                backgroundColor: colors.chipBg,
                paddingHorizontal: 5,
                paddingVertical: 1,
                borderRadius: 3,
              }}
            >
              {row.shortHash}
            </Text>
            {row.author ? (
              <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 10, flexShrink: 1 }}>
                {row.author}
              </Text>
            ) : null}
            <Text style={{ color: colors.fgMuted, fontSize: 10 }}>
              {row.date ? relativeTime(row.date) : ""}
            </Text>
          </View>
        </View>
      </Pressable>
      {expanded ? (
        <View>
          <View style={{ height: 1, backgroundColor: colors.hairline, marginLeft: graphW }} />
          <CommitExpansion
            directory={directory}
            hash={row.hash}
            theme={theme}
            expandedFile={expandedFile}
            onToggleFile={onToggleFile}
            graphW={graphW}
          />
        </View>
      ) : null}
      </View>
      <View style={{ height: CARD_GAP }} />
      <GraphSlice row={row} prevRow={prevRow} height={sliceH} graphW={graphW} />
    </View>
  );
});

// --- Windowed list -------------------------------------------------------------

function itemOffset(
  index: number,
  collapsedH: number,
  expandedIndex: number,
  expandedH: number,
): number {
  const base = LIST_PAD_Y + index * collapsedH;
  if (expandedIndex >= 0 && index > expandedIndex) return base + (expandedH - collapsedH);
  return base;
}

function indexAtY(
  y: number,
  count: number,
  collapsedH: number,
  expandedIndex: number,
  expandedH: number,
): number {
  if (count <= 0) return 0;
  if (y <= 0) return 0;
  const last = count - 1;
  if (expandedIndex < 0) return Math.min(last, Math.floor(y / collapsedH));
  const top = expandedIndex * collapsedH;
  if (y < top) return Math.min(expandedIndex, Math.floor(y / collapsedH));
  if (y < top + expandedH) return expandedIndex;
  return Math.min(last, expandedIndex + 1 + Math.floor((y - top - expandedH) / collapsedH));
}

function windowRange(
  scrollY: number,
  viewportH: number,
  count: number,
  collapsedH: number,
  expandedIndex: number,
  expandedH: number,
): { start: number; end: number } {
  if (count === 0) return { start: 0, end: 0 };
  const vh = viewportH > 0 ? viewportH : collapsedH * 24;
  const localY = scrollY - LIST_PAD_Y;
  const start = Math.max(0, indexAtY(localY, count, collapsedH, expandedIndex, expandedH) - LIST_OVERSCAN);
  const end = Math.min(
    count,
    indexAtY(localY + vh, count, collapsedH, expandedIndex, expandedH) + LIST_OVERSCAN + 1,
  );
  return { start, end: Math.max(end, start) };
}

function VirtualCommitList({
  rows,
  graphW,
  colors,
  compact,
  expandedHash,
  expandedFile,
  directory,
  theme,
  onToggle,
  onToggleFile,
  onOpenMenu,
  onShowTip,
  onHideTip,
  onScrollDismiss,
}: {
  rows: GitTreeRow[];
  graphW: number;
  colors: RowColors;
  compact: boolean;
  expandedHash: string | null;
  expandedFile: string | null;
  directory: string;
  theme: PluginWorkspacePanelProps["theme"];
  onToggle: (hash: string) => void;
  onToggleFile: (path: string) => void;
  onOpenMenu: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onShowTip: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onHideTip: () => void;
  onScrollDismiss: () => void;
}) {
  const expandedIndex = useMemo(
    () => (expandedHash ? rows.findIndex((r) => r.hash === expandedHash) : -1),
    [rows, expandedHash],
  );
  const [collapsedH, setCollapsedH] = useState(COLLAPSED_ROW_H);
  const [expandedH, setExpandedH] = useState(COLLAPSED_ROW_H);
  const collapsedLocked = useRef(false);
  const expandedIndexRef = useRef(expandedIndex);
  expandedIndexRef.current = expandedIndex;
  const viewportRef = useRef(0);
  const scrollYRef = useRef(0);
  const rangeRef = useRef({ start: 0, end: Math.min(rows.length, LIST_OVERSCAN * 2 + 12) });
  const [range, setRange] = useState(rangeRef.current);

  const applyRange = useCallback(
    (scrollY: number, viewportH: number, count: number, expIdx: number, expH: number, rowH: number) => {
      const next = windowRange(scrollY, viewportH, count, rowH, expIdx, expH);
      const cur = rangeRef.current;
      if (cur.start === next.start && cur.end === next.end) return;
      rangeRef.current = next;
      setRange(next);
    },
    [],
  );

  useEffect(() => {
    collapsedLocked.current = false;
  }, [rows]);

  useEffect(() => {
    setExpandedH(COLLAPSED_ROW_H);
  }, [expandedHash]);

  useEffect(() => {
    applyRange(scrollYRef.current, viewportRef.current, rows.length, expandedIndex, expandedH, collapsedH);
  }, [applyRange, rows.length, expandedIndex, expandedH, collapsedH]);

  const onHeight = useCallback((index: number, height: number) => {
    if (height <= 0) return;
    if (index === expandedIndexRef.current) {
      setExpandedH((cur) => (Math.abs(cur - height) > 0.5 ? height : cur));
      return;
    }
    if (!collapsedLocked.current) {
      collapsedLocked.current = true;
      setCollapsedH((cur) => (Math.abs(cur - height) > 0.5 ? height : cur));
    }
  }, []);

  const extra = expandedIndex >= 0 ? Math.max(0, expandedH - collapsedH) : 0;
  const totalH = LIST_PAD_Y * 2 + rows.length * collapsedH + extra;

  const indices: number[] = [];
  for (let i = range.start; i < range.end; i++) indices.push(i);
  if (expandedIndex >= 0 && (expandedIndex < range.start || expandedIndex >= range.end)) {
    indices.push(expandedIndex);
    indices.sort((a, b) => a - b);
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: LIST_PAD_X }}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h <= 0) return;
        viewportRef.current = h;
        applyRange(scrollYRef.current, h, rows.length, expandedIndex, expandedH, collapsedH);
      }}
      onScroll={(e) => {
        onScrollDismiss();
        const y = e.nativeEvent.contentOffset.y;
        scrollYRef.current = y;
        applyRange(y, viewportRef.current, rows.length, expandedIndex, expandedH, collapsedH);
      }}
      scrollEventThrottle={16}
    >
      <View style={{ height: totalH, position: "relative" as const, overflow: "visible" as const }}>
        {indices.map((i) => (
          <View
            key={`${rows[i].hash}-${i}`}
            style={{
              position: "absolute" as const,
              top: itemOffset(i, collapsedH, expandedIndex, expandedH),
              left: 0,
              right: 0,
            }}
          >
            <CommitRow
              row={rows[i]}
              prevRow={i > 0 ? rows[i - 1] : undefined}
              index={i}
              graphW={graphW}
              colors={colors}
              compact={compact}
              expanded={expandedHash === rows[i].hash}
              expandedFile={expandedHash === rows[i].hash ? expandedFile : null}
              onToggle={onToggle}
              onToggleFile={onToggleFile}
              directory={directory}
              theme={theme}
              onOpenMenu={onOpenMenu}
              onShowTip={onShowTip}
              onHideTip={onHideTip}
              onHeight={onHeight}
            />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// --- Panel ----------------------------------------------------------------------

export function GitTreePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (w) => ({
    directory: w.directory,
    name: w.name,
    projectKind: w.projectKind,
  }));
  const getTree = useRpc(gitTree);
  const runBranch = useRpc(gitBranchOp);
  const toast = useToast();
  const shellRef = useRef<View>(null);
  const branchTriggerRef = useRef<View>(null);

  const directory = workspace?.directory ?? null;
  const [data, setData] = useState<GitTreeOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; row: GitTreeRow } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: GitTreeRow } | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number } | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const menuOpen = useRef(false);
  const [scope, setScope] = useState<TreeScope>("all");
  const [refreshHover, setRefreshHover] = useState(false);
  const [searchHover, setSearchHover] = useState(false);
  const [branchHover, setBranchHover] = useState(false);

  const refresh = useCallback(() => {
    if (!directory) return;
    setLoading(true);
    getTree({ directory, limit: COMMIT_LIMIT, scope })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [directory, getTree, scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleCommit = useCallback((hash: string) => {
    setExpandedHash((cur) => (cur === hash ? null : hash));
    setExpandedFile(null);
  }, []);

  const toggleFile = useCallback((path: string) => {
    setExpandedFile((cur) => (cur === path ? null : path));
  }, []);

  const placeAt = useCallback((pageX: number, pageY: number, width: number, height: number, cb: (x: number, y: number) => void) => {
    const node = shellRef.current;
    if (!node || typeof node.measureInWindow !== "function") {
      cb(pageX, pageY);
      return;
    }
    node.measureInWindow((x, y, w, h) => {
      const localX = Math.min(Math.max(8, pageX - x), Math.max(8, w - width));
      const localY = Math.min(Math.max(8, pageY - y), Math.max(8, h - height));
      cb(localX, localY);
    });
  }, []);

  const dismissFloats = useCallback(() => {
    menuOpen.current = false;
    setTip(null);
    setMenu(null);
    setBranchMenu(null);
  }, []);

  const handleOpenMenu = useCallback(
    (row: GitTreeRow, pageX: number, pageY: number) => {
      menuOpen.current = true;
      setTip(null);
      setBranchMenu(null);
      placeAt(pageX, pageY, 208, 92, (x, y) => setMenu({ x, y, row }));
    },
    [placeAt],
  );

  const handleShowTip = useCallback(
    (row: GitTreeRow, pageX: number, pageY: number) => {
      if (menuOpen.current || branchMenu) return;
      placeAt(pageX, pageY, 308, 88, (x, y) => setTip({ x, y, row }));
    },
    [placeAt, branchMenu],
  );

  const handleHideTip = useCallback(() => setTip(null), []);

  const openBranchMenu = useCallback(() => {
    if (branchMenu) return;
    menuOpen.current = false;
    setMenu(null);
    setTip(null);
    const node = branchTriggerRef.current;
    if (!node || typeof node.measureInWindow !== "function") {
      setBranchMenu({ x: 8, y: 40 });
      return;
    }
    node.measureInWindow((x, y, _w, h) => {
      placeAt(x, y + h + 6, 268, 320, (lx, ly) => setBranchMenu({ x: lx, y: ly }));
    });
  }, [branchMenu, placeAt]);

  const handleBranchOp = useCallback(
    (op: GitBranchOp | "copy", name?: string) => {
      if (op === "copy") {
        if (!name) return;
        void copyToClipboard(name).then((ok) => {
          if (ok) toast.show("Copied branch name");
          else toast.error("Couldn't copy");
        });
        return;
      }
      if (!directory || branchBusy) return;
      setBranchBusy(true);
      void runBranch({ directory, op, name })
        .then((result) => {
          if (result.error) {
            toast.error(result.error);
            return;
          }
          const done: Record<GitBranchOp, string> = {
            checkout: name ? `Switched to ${name}` : "Checked out",
            merge: name ? `Merged ${name}` : "Merged",
            delete: name ? `Deleted ${name}` : "Deleted",
            pull: "Pulled",
            create: name ? `Created ${name}` : "Created branch",
          };
          toast.show(done[op]);
          refresh();
          if (op !== "delete") setBranchMenu(null);
        })
        .catch(() => toast.error("Git operation failed"))
        .finally(() => setBranchBusy(false));
    },
    [directory, branchBusy, runBranch, toast, refresh],
  );

  const colors: RowColors = useMemo(
    () => ({
      fg: theme.colors.foreground,
      fgMuted: theme.colors.foregroundMuted,
      success: theme.colors.statusSuccess,
      chipBg: theme.colors.surface1,
      selected: theme.colors.surface2,
      hoverBg: theme.colors.surface2,
      expandedBg: theme.colors.surface2,
      hairline: theme.colors.border + "66",
      ring: theme.colors.border + "40",
      cardBg: theme.colors.surface1,
    }),
    [theme],
  );

  const floatColors: FloatColors = useMemo(
    () => ({
      fg: theme.colors.foreground,
      fgMuted: theme.colors.foregroundMuted,
      surface: theme.colors.surface2,
      ring: theme.colors.border + "66",
      hover: theme.colors.surface1,
    }),
    [theme],
  );

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 } as const,
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: layout.compact ? 10 : 14,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border + "66",
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 12 : 13,
        fontWeight: "600" as const,
      },
      subtitle: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        marginTop: 1,
      },
      empty: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 24,
        gap: 8,
      },
      emptyText: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        textAlign: "center" as const,
      },
      errorText: { color: theme.colors.statusDanger, fontSize: 12, textAlign: "center" as const },
    }),
    [theme, layout.compact],
  );

  if (!workspace) {
    return (
      <View style={styles.screen}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Workspace unavailable</Text>
        </View>
      </View>
    );
  }

  const allRows = data?.rows ?? [];
  const queryTrim = query.trim().toLowerCase();
  const { rows, graphW } = useMemo(() => {
    if (!queryTrim) return { rows: allRows, graphW: graphWidth(laneCountOf(allRows)) };
    const hits = allRows.filter(
      (r) =>
        r.subject.toLowerCase().includes(queryTrim) ||
        r.author.toLowerCase().includes(queryTrim) ||
        r.hash.toLowerCase().startsWith(queryTrim) ||
        r.refs.some((ref) => ref.toLowerCase().includes(queryTrim)),
    );
    // Recompute lanes on the filtered subset so the graph stays connected.
    const relaid = computeGraph(hits);
    return { rows: relaid, graphW: graphWidth(laneCountOf(relaid)) };
  }, [allRows, queryTrim]);
  const heads = data?.heads ?? [];
  const currentHead = heads.find((h) => h.isCurrent);
  const triggerName = currentHead?.name ?? (heads.length > 0 ? "HEAD" : null);
  const triggerColor = currentHead ? branchColor(currentHead.name) : theme.colors.foregroundMuted;

  return (
    <View ref={shellRef} style={styles.screen}>
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
          <Text style={styles.title}>Git Tree</Text>
          {rows.length > 0 ? (
            <Text style={styles.subtitle}>
              {queryTrim
                ? `${rows.length} of ${allRows.length} commits match "${query.trim()}"`
                : `${rows.length} commit${rows.length === 1 ? "" : "s"}`}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 4, marginTop: 4 }}>
            {(
              [
                ["current", "Branch"],
                ["local", "Local"],
                ["all", "All"],
              ] as const
            ).map(([value, label]) => {
              const active = scope === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  onPress={() => setScope(value)}
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 5,
                    borderWidth: 1,
                    borderColor: active ? theme.colors.accent + "99" : theme.colors.border + "66",
                    backgroundColor: active ? theme.colors.accent + "22" : "transparent",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 10,
                      fontWeight: active ? "700" : "500",
                      color: active ? theme.colors.accent : theme.colors.foregroundMuted,
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        {triggerName ? (
          <View ref={branchTriggerRef} style={{ flexShrink: 1, minWidth: 0, marginRight: 4 }}>
            <Pressable
              accessibilityRole="button"
              onPress={openBranchMenu}
              onHoverIn={() => setBranchHover(true)}
              onHoverOut={() => setBranchHover(false)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                maxWidth: layout.compact ? 140 : 200,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 999,
                backgroundColor: branchHover || branchMenu ? withAlpha(triggerColor, "33") : withAlpha(triggerColor, "22"),
                borderWidth: 1,
                borderColor: withAlpha(triggerColor, "99"),
              }}
            >
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: triggerColor,
                  flexShrink: 0,
                }}
              />
              <Text
                numberOfLines={1}
                style={{
                  color: theme.colors.foreground,
                  fontSize: 12,
                  fontWeight: "600",
                  flexShrink: 1,
                }}
              >
                {triggerName}
              </Text>
              <Icon name="ChevronDown" size={12} color={triggerColor} />
            </Pressable>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setSearching((v) => !v);
            if (searching) setQuery("");
          }}
          onHoverIn={() => setSearchHover(true)}
          onHoverOut={() => setSearchHover(false)}
          hitSlop={8}
          style={{
            padding: 6,
            borderRadius: 6,
            backgroundColor: searchHover || searching ? theme.colors.surface1 : "transparent",
          }}
        >
          <Icon
            name="Search"
            size={14}
            color={searching ? theme.colors.accent : theme.colors.foreground}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={refresh}
          onHoverIn={() => setRefreshHover(true)}
          onHoverOut={() => setRefreshHover(false)}
          hitSlop={8}
          style={{
            padding: 6,
            borderRadius: 6,
            backgroundColor: refreshHover ? theme.colors.surface1 : "transparent",
          }}
        >
          <Icon
            name="RefreshCw"
            size={14}
            color={loading ? theme.colors.foregroundMuted : theme.colors.foreground}
          />
        </Pressable>
      </View>

      {searching ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: layout.compact ? 10 : 14,
            paddingVertical: 6,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border + "66",
          }}
        >
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Filter by message, author, hash or branch…"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoFocus
            style={{
              flex: 1,
              color: theme.colors.foreground,
              fontSize: 12,
              paddingHorizontal: 8,
              paddingVertical: 5,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border + "66",
              backgroundColor: theme.colors.surface1,
            }}
          />
          {query ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setQuery("")}
              hitSlop={8}
              style={{ padding: 4 }}
            >
              <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {data?.error ? (
        <View style={styles.empty}>
          <Icon name="CircleAlert" size={18} color={theme.colors.statusDanger} />
          <Text style={styles.errorText}>{data.error}</Text>
        </View>
      ) : rows.length === 0 && !loading ? (
        <View style={styles.empty}>
          <Icon name="GitBranch" size={18} color={theme.colors.foregroundMuted} />
          <Text style={styles.emptyText}>No commits found</Text>
        </View>
      ) : (
        <VirtualCommitList
          rows={rows}
          graphW={graphW}
          colors={colors}
          compact={layout.compact}
          expandedHash={expandedHash}
          expandedFile={expandedFile}
          directory={directory ?? ""}
          theme={theme}
          onToggle={toggleCommit}
          onToggleFile={toggleFile}
          onOpenMenu={handleOpenMenu}
          onShowTip={handleShowTip}
          onHideTip={handleHideTip}
          onScrollDismiss={dismissFloats}
        />
      )}

      {tip && !menu && !branchMenu ? <CommitTip x={tip.x} y={tip.y} row={tip.row} colors={floatColors} /> : null}
      {menu ? (
        <CommitMenu
          x={menu.x}
          y={menu.y}
          row={menu.row}
          colors={floatColors}
          onDismiss={() => {
            menuOpen.current = false;
            setMenu(null);
          }}
          onCopy={(kind) => {
            const target = menu.row;
            const text = kind === "message" ? target.subject : target.hash;
            void copyToClipboard(text).then((ok) => {
              menuOpen.current = false;
              setMenu(null);
              if (ok) toast.show(kind === "message" ? "Copied commit message" : "Copied commit hash");
              else toast.error("Couldn't copy");
            });
          }}
        />
      ) : null}
      {branchMenu ? (
        <BranchMenu
          x={branchMenu.x}
          y={branchMenu.y}
          heads={heads}
          colors={floatColors}
          busy={branchBusy}
          onDismiss={() => setBranchMenu(null)}
          onOp={handleBranchOp}
        />
      ) : null}
    </View>
  );
}
