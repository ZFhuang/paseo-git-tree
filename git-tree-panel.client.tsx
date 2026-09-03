import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  commitCompare,
  commitCompareDiff,
  commitDetail,
  commitDiff,
  computeGraph,
  gitBranchOp,
  gitCommitOp,
  gitTree,
  graphColor,
  assignRefColors,
  isUncommittedHash,
  uncommittedRow,
  type CommitCompareOutput,
  type CommitCompareDiffOutput,
  type CommitDetailOutput,
  type TreeScope,
  type CommitDiffOutput,
  type GitBranchOp,
  type GitCommitOp,
  type GitTreeOutput,
  type GitTreeRow,
  parseBranchRef,
  splitRemoteRef,
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

/** Fallback hash when a label is not in the ref-colour map. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tintForRef(name: string, refColors: Map<string, number>): string {
  const i = refColors.get(name);
  return i !== undefined ? graphColor(i) : graphColor(hashString(name));
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

/** Stop Paseo's host menu. Do not stopPropagation in capture so row handlers still run. */
function suppressHostMenu(e: WebContextMenuEvent) {
  e.preventDefault();
}

const hostMenuBlock = {
  onContextMenuCapture: (e: WebContextMenuEvent) => suppressHostMenu(e),
  onContextMenu: (e: WebContextMenuEvent) => {
    suppressHostMenu(e);
    e.stopPropagation();
  },
} as object;

function bindContextMenu(open: (pageX: number, pageY: number) => void) {
  return {
    onContextMenuCapture: (e: WebContextMenuEvent) => suppressHostMenu(e),
    onContextMenu: (e: WebContextMenuEvent) => {
      e.preventDefault();
      e.stopPropagation();
      open(e.nativeEvent.pageX, e.nativeEvent.pageY);
    },
  } as object;
}

/** Full-panel dismiss layer. Right-click here closes our menu and never opens the host's. */
function MenuScrim({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Pressable
      onPress={onDismiss}
      {...({
        onContextMenuCapture: (e: WebContextMenuEvent) => {
          suppressHostMenu(e);
          onDismiss();
        },
        onContextMenu: (e: WebContextMenuEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        },
      } as object)}
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 41 }}
    />
  );
}

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
  const incomingTint = row.incomingColor != null ? graphColor(row.incomingColor) : graphColor(row.color);
  const dotTint = graphColor(row.color);
  for (const edge of row.edges) {
    const color = graphColor(edge.color);
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
      const splitOwn =
        edge.from === row.lane &&
        arrived.has(edge.from) &&
        row.incomingColor != null &&
        row.incomingColor !== row.color;
      if (splitOwn) {
        segs.push({
          key: `${edge.from}>${edge.to}@in-split`,
          x1: x,
          y1: 0,
          x2: x,
          y2: cy,
          color: incomingTint,
        });
        segs.push({
          key: `${edge.from}>${edge.to}@out-split`,
          x1: x,
          y1: cy,
          x2: x,
          y2: bottom,
          color: dotTint,
        });
      } else {
        segs.push({
          key: `${edge.from}>${edge.to}@thru`,
          x1: x,
          y1: startY,
          x2: x,
          y2: bottom,
          color,
        });
      }
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
      color: incomingTint,
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
          backgroundColor: graphColor(row.color),
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
  currentName,
  colors,
  busy,
  onCopy,
  onAct,
  onDismiss,
}: {
  x: number;
  y: number;
  row: GitTreeRow;
  currentName: string | null;
  colors: FloatColors;
  busy: boolean;
  onCopy: (kind: "message" | "hash") => void;
  onAct: (req: {
    op: GitCommitOp;
    hash: string;
    name?: string;
    mode?: "soft" | "mixed" | "hard";
    checkOut?: boolean;
  }) => void;
  onDismiss: () => void;
}) {
  const uncommitted = isUncommittedHash(row.hash);
  const [creating, setCreating] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [newName, setNewName] = useState("");
  const [checkOutNew, setCheckOutNew] = useState(true);
  const [confirm, setConfirm] = useState<"revert" | "rebase" | "reset-hard" | null>(null);

  return (
    <>
      <MenuScrim onDismiss={onDismiss} />
      <View
        {...hostMenuBlock}
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: 280,
          maxHeight: 380,
          zIndex: 42,
          backgroundColor: colors.surface,
          borderRadius: CARD_RADIUS,
          borderWidth: 1,
          borderColor: colors.ring,
          paddingVertical: 4,
          opacity: busy ? 0.7 : 1,
          ...FLOAT_SHADOW,
        }}
      >
        <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 372 }}>
          {uncommitted ? null : (
            <>
              <Pressable
                onPress={() => {
                  setCreating((v) => !v);
                  setTagging(false);
                  setConfirm(null);
                }}
                style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Text style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>Create branch…</Text>
              </Pressable>
              {creating ? (
                <View style={{ paddingHorizontal: 10, paddingBottom: 8, gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <TextInput
                      value={newName}
                      onChangeText={setNewName}
                      placeholder="branch-name"
                      placeholderTextColor={colors.fgMuted}
                      autoFocus
                      editable={!busy}
                      onSubmitEditing={() => {
                        const n = newName.trim();
                        if (n) onAct({ op: "create-branch", hash: row.hash, name: n, checkOut: checkOutNew });
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
                        if (n) onAct({ op: "create-branch", hash: row.hash, name: n, checkOut: checkOutNew });
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
                  <Pressable onPress={() => setCheckOutNew((v) => !v)}>
                    <Text style={{ color: colors.fg, fontSize: 12 }}>{checkOutNew ? "☑" : "☐"} Check out after create</Text>
                  </Pressable>
                </View>
              ) : null}
              <MenuItem
                label="Checkout this commit"
                hint="detached HEAD"
                colors={colors}
                onPress={() => onAct({ op: "checkout", hash: row.hash })}
              />
              <MenuItem
                label="Cherry pick"
                hint={`git cherry-pick ${row.shortHash}`}
                colors={colors}
                onPress={() => onAct({ op: "cherry-pick", hash: row.hash })}
              />
              {confirm === "revert" ? (
                <MenuItem
                  label="Confirm revert"
                  hint={`git revert ${row.shortHash}`}
                  colors={colors}
                  onPress={() => onAct({ op: "revert", hash: row.hash })}
                />
              ) : (
                <MenuItem
                  label="Revert…"
                  hint="creates a reverting commit"
                  colors={colors}
                  onPress={() => setConfirm("revert")}
                />
              )}
              {currentName ? (
                <MenuItem
                  label={`Merge into ${currentName}`}
                  hint={`git merge ${row.shortHash}`}
                  colors={colors}
                  onPress={() => onAct({ op: "merge", hash: row.hash })}
                />
              ) : null}
              {confirm === "rebase" && currentName ? (
                <MenuItem
                  label={`Confirm rebase ${currentName}`}
                  hint={`git rebase ${row.shortHash}`}
                  colors={colors}
                  onPress={() => onAct({ op: "rebase", hash: row.hash })}
                />
              ) : currentName ? (
                <MenuItem
                  label={`Rebase ${currentName} onto this`}
                  hint={`git rebase ${row.shortHash}`}
                  colors={colors}
                  onPress={() => setConfirm("rebase")}
                />
              ) : null}
              {currentName ? (
                <>
                  <MenuItem
                    label={`Reset ${currentName} here`}
                    hint="git reset --mixed"
                    colors={colors}
                    onPress={() => onAct({ op: "reset", hash: row.hash, mode: "mixed" })}
                  />
                  {confirm === "reset-hard" ? (
                    <MenuItem
                      label="Confirm hard reset"
                      hint="git reset --hard · discards worktree"
                      colors={colors}
                      onPress={() => onAct({ op: "reset", hash: row.hash, mode: "hard" })}
                    />
                  ) : (
                    <MenuItem
                      label="Hard reset…"
                      hint="git reset --hard"
                      colors={colors}
                      onPress={() => setConfirm("reset-hard")}
                    />
                  )}
                </>
              ) : null}
              <Pressable
                onPress={() => {
                  setTagging((v) => !v);
                  setCreating(false);
                  setConfirm(null);
                  setNewName("");
                }}
                style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Text style={{ color: colors.fg, fontSize: 12 }}>Add tag…</Text>
              </Pressable>
              {tagging ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingBottom: 8 }}>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    placeholder="tag-name"
                    placeholderTextColor={colors.fgMuted}
                    autoFocus
                    editable={!busy}
                    onSubmitEditing={() => {
                      const n = newName.trim();
                      if (n) onAct({ op: "tag", hash: row.hash, name: n });
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
                      if (n) onAct({ op: "tag", hash: row.hash, name: n });
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
                    <Text style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>Tag</Text>
                  </Pressable>
                </View>
              ) : null}
            </>
          )}
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
        </ScrollView>
      </View>
    </>
  );
}

function FileMenu({
  x,
  y,
  path,
  colors,
  onFilter,
  onCopy,
  onDismiss,
}: {
  x: number;
  y: number;
  path: string;
  colors: FloatColors;
  onFilter: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <MenuScrim onDismiss={onDismiss} />
      <View
        {...hostMenuBlock}
        style={{
          position: "absolute",
          left: x,
          top: y,
          minWidth: 220,
          maxWidth: 360,
          zIndex: 42,
          backgroundColor: colors.surface,
          borderRadius: CARD_RADIUS,
          borderWidth: 1,
          borderColor: colors.ring,
          paddingVertical: 4,
          ...FLOAT_SHADOW,
        }}
      >
        <MenuItem label="Filter commits by this file" hint={`f: ${path}`} colors={colors} onPress={onFilter} />
        <MenuItem label="Copy path" hint={path} colors={colors} onPress={onCopy} />
      </View>
    </>
  );
}

const SCOPE_OPTIONS: Array<{ value: TreeScope; short: string; label: string; hint: string }> = [
  { value: "current", short: "Branch", label: "Current branch", hint: "Only the checked-out branch" },
  { value: "local", short: "Local", label: "Local branches", hint: "All local heads, no remotes" },
  { value: "all", short: "All", label: "All refs", hint: "Local, remotes, and tags" },
];

function ScopeMenu({
  x,
  y,
  scope,
  colors,
  onSelect,
  onDismiss,
}: {
  x: number;
  y: number;
  scope: TreeScope;
  colors: FloatColors;
  onSelect: (scope: TreeScope) => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <MenuScrim onDismiss={onDismiss} />
      <View
        {...hostMenuBlock}
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
        {SCOPE_OPTIONS.map((opt) => (
          <MenuItem
            key={opt.value}
            label={scope === opt.value ? `✓  ${opt.label}` : opt.label}
            hint={opt.hint}
            colors={colors}
            onPress={() => onSelect(opt.value)}
          />
        ))}
      </View>
    </>
  );
}

type BranchHead = { name: string; hash: string; isCurrent: boolean; remote: boolean };

function resolveHead(
  name: string,
  heads: BranchHead[],
  hash: string,
  remotes: string[],
): BranchHead {
  const found = heads.find((h) => h.name === name);
  if (found) return found;
  const parsed = parseBranchRef(name, remotes);
  return { name, hash, isCurrent: false, remote: parsed?.remote ?? false };
}

type BranchOpRequest = {
  op: GitBranchOp | "copy";
  name?: string;
  newName?: string;
  force?: boolean;
  checkOut?: boolean;
};

function BranchListRow({
  name,
  color,
  isCurrent,
  remote,
  previewing,
  colors,
  onPrimary,
  onMore,
}: {
  name: string;
  color: string;
  isCurrent: boolean;
  remote: boolean;
  previewing: boolean;
  colors: FloatColors;
  onPrimary: () => void;
  onMore: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPrimary}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onLongPress={onMore}
      {...bindContextMenu(() => onMore())}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: 12,
        paddingRight: 4,
        paddingVertical: 7,
        backgroundColor: previewing || hovered ? colors.hover : "transparent",
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: color,
          flexShrink: 0,
        }}
      />
      <Text
        numberOfLines={1}
        style={{
          color: colors.fg,
          fontSize: 12,
          fontWeight: isCurrent || previewing ? "700" : "500",
          flex: 1,
          flexShrink: 1,
        }}
      >
        {name}
      </Text>
      {remote ? (
        <Text style={{ color: colors.fgMuted, fontSize: 10 }}>remote</Text>
      ) : null}
      {previewing ? (
        <Text style={{ color, fontSize: 10, fontWeight: "700" }}>preview</Text>
      ) : null}
      {isCurrent ? (
        <Text style={{ color, fontSize: 10, fontWeight: "700" }}>current</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${name}`}
        onPress={(e) => {
          (e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
          onMore();
        }}
        style={{
          width: 28,
          height: 28,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        }}
      >
        <Text style={{ color: colors.fgMuted, fontSize: 16, lineHeight: 18 }}>⋯</Text>
      </Pressable>
    </Pressable>
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
        paddingVertical: 7,
        marginHorizontal: 4,
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

function BranchSectionLabel({ label, colors }: { label: string; colors: FloatColors }) {
  return (
    <Text
      style={{
        color: colors.fgMuted,
        fontSize: 10,
        fontWeight: "700",
        textTransform: "uppercase" as const,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 2,
      }}
    >
      {label}
    </Text>
  );
}

function BranchMenu({
  x,
  y,
  heads,
  remotes,
  preview,
  focus,
  colors,
  busy,
  tintFor,
  onDismiss,
  onPreview,
  onOp,
}: {
  x: number;
  y: number;
  heads: BranchHead[];
  remotes: string[];
  preview: string | null;
  /** When set, skip the picker and open Git Graph actions for this ref. */
  focus?: BranchHead;
  colors: FloatColors;
  busy: boolean;
  tintFor: (name: string) => string;
  onDismiss: () => void;
  onPreview: (name: string) => void;
  onOp: (req: BranchOpRequest) => void;
}) {
  const current = heads.find((h) => h.isCurrent && !h.remote);
  const localNames = useMemo(
    () => new Set(heads.filter((h) => !h.remote).map((h) => h.name)),
    [heads],
  );
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [checkOutNew, setCheckOutNew] = useState(true);
  const [active, setActive] = useState<BranchHead | null>(focus ?? null);
  const [renameTo, setRenameTo] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "rebase" | "push-force" | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (h: BranchHead) => !q || h.name.toLowerCase().includes(q);
    const locals = heads
      .filter((h) => !h.remote && match(h))
      .slice()
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const remoteHeads = heads
      .filter((h) => h.remote && match(h))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    return { locals, remoteHeads };
  }, [heads, filter]);

  const openActions = (h: BranchHead) => {
    setActive(h);
    setConfirm(null);
    setRenaming(false);
    setRenameTo(h.remote ? "" : h.name);
    setCreating(false);
  };

  const localFamily = (h: BranchHead) => parseBranchRef(h.name, remotes)?.family ?? h.name;

  return (
    <>
      <MenuScrim onDismiss={onDismiss} />
      <View
        {...hostMenuBlock}
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: 300,
          maxHeight: 420,
          zIndex: 42,
          backgroundColor: colors.surface,
          borderRadius: CARD_RADIUS,
          borderWidth: 1,
          borderColor: colors.ring,
          paddingVertical: 4,
          opacity: busy ? 0.7 : 1,
          ...FLOAT_SHADOW,
        }}
      >
        {active ? (
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 412 }}>
            {focus ? (
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: tintFor(active.name),
                  }}
                />
                <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
                  {active.name}
                </Text>
              </View>
            ) : (
            <Pressable
              onPress={() => {
                setActive(null);
                setConfirm(null);
                setRenaming(false);
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{ color: colors.fgMuted, fontSize: 12 }}>‹ Back</Text>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: tintFor(active.name),
                }}
              />
              <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
                {active.name}
              </Text>
            </Pressable>
            )}
            {active.isCurrent ? (
              remotes.length > 0 ? (
                confirm === "push-force" ? (
                  <BranchAction
                    label="Confirm force push"
                    hint="git push --force-with-lease"
                    colors={colors}
                    danger
                    disabled={busy}
                    onPress={() => onOp({ op: "push", name: active.name, force: true })}
                  />
                ) : (
                  <BranchAction
                    label="Force push…"
                    hint="--force-with-lease"
                    colors={colors}
                    danger
                    disabled={busy}
                    onPress={() => setConfirm("push-force")}
                  />
                )
              ) : null
            ) : (
              <>
                <BranchAction
                  label="Checkout"
                  hint={
                    active.remote
                      ? localNames.has(localFamily(active))
                        ? `git checkout ${localFamily(active)}`
                        : `git checkout --track ${active.name}`
                      : `git checkout ${active.name}`
                  }
                  colors={colors}
                  disabled={busy}
                  onPress={() => onOp({ op: "checkout", name: active.name })}
                />
                {current && !active.remote ? (
                  <>
                    <BranchAction
                      label={`Merge into ${current.name}`}
                      hint={`git merge ${active.name}`}
                      colors={colors}
                      disabled={busy}
                      onPress={() => onOp({ op: "merge", name: active.name })}
                    />
                    {confirm === "rebase" ? (
                      <BranchAction
                        label={`Confirm rebase ${current.name}`}
                        hint={`git rebase ${active.name}`}
                        colors={colors}
                        danger
                        disabled={busy}
                        onPress={() => onOp({ op: "rebase", name: active.name })}
                      />
                    ) : (
                      <BranchAction
                        label={`Rebase ${current.name} onto this`}
                        hint={`git rebase ${active.name}`}
                        colors={colors}
                        disabled={busy}
                        onPress={() => setConfirm("rebase")}
                      />
                    )}
                  </>
                ) : null}
                {active.remote && current ? (
                  <BranchAction
                    label={`Pull into ${current.name}`}
                    hint={(() => {
                      const parts = splitRemoteRef(active.name, remotes);
                      return parts ? `git pull ${parts.remote} ${parts.branch}` : `git pull ${active.name}`;
                    })()}
                    colors={colors}
                    disabled={busy}
                    onPress={() => onOp({ op: "pull", name: active.name })}
                  />
                ) : null}
                {active.remote && localNames.has(localFamily(active)) && current?.name !== localFamily(active) ? (
                  <BranchAction
                    label={`Fetch into ${localFamily(active)}`}
                    hint={`git fetch … ${localFamily(active)}:${localFamily(active)}`}
                    colors={colors}
                    disabled={busy}
                    onPress={() => onOp({ op: "fetch", name: active.name })}
                  />
                ) : null}
                {!active.remote && remotes.length > 0 ? (
                  <>
                    <BranchAction
                      label="Push"
                      hint="git push -u"
                      colors={colors}
                      disabled={busy}
                      onPress={() => onOp({ op: "push", name: active.name })}
                    />
                    {confirm === "push-force" ? (
                      <BranchAction
                        label="Confirm force push"
                        hint="git push --force-with-lease"
                        colors={colors}
                        danger
                        disabled={busy}
                        onPress={() => onOp({ op: "push", name: active.name, force: true })}
                      />
                    ) : (
                      <BranchAction
                        label="Force push…"
                        hint="--force-with-lease"
                        colors={colors}
                        danger
                        disabled={busy}
                        onPress={() => setConfirm("push-force")}
                      />
                    )}
                  </>
                ) : null}
              </>
            )}
            {!active.remote ? (
              renaming ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
                  <TextInput
                    value={renameTo}
                    onChangeText={setRenameTo}
                    placeholder="new-name"
                    placeholderTextColor={colors.fgMuted}
                    autoFocus
                    editable={!busy}
                    onSubmitEditing={() => {
                      const n = renameTo.trim();
                      if (n) onOp({ op: "rename", name: active.name, newName: n });
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
                      const n = renameTo.trim();
                      if (n) onOp({ op: "rename", name: active.name, newName: n });
                    }}
                    disabled={busy || !renameTo.trim() || renameTo.trim() === active.name}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      borderRadius: 6,
                      backgroundColor: colors.hover,
                      opacity: busy || !renameTo.trim() || renameTo.trim() === active.name ? 0.45 : 1,
                    }}
                  >
                    <Text style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>Rename</Text>
                  </Pressable>
                </View>
              ) : (
                <BranchAction
                  label="Rename…"
                  hint="git branch -m"
                  colors={colors}
                  disabled={busy}
                  onPress={() => {
                    setRenaming(true);
                    setConfirm(null);
                  }}
                />
              )
            ) : null}
            <BranchAction
              label="Copy name"
              hint={active.name}
              colors={colors}
              disabled={busy}
              onPress={() => onOp({ op: "copy", name: active.name })}
            />
            {!active.isCurrent ? (
              confirm === "delete" ? (
                active.remote ? (
                  <BranchAction
                    label="Confirm delete remote"
                    hint="git push --delete"
                    colors={colors}
                    danger
                    disabled={busy}
                    onPress={() => onOp({ op: "delete", name: active.name })}
                  />
                ) : (
                  <>
                    <BranchAction
                      label="Confirm delete"
                      hint={`git branch -d ${active.name}`}
                      colors={colors}
                      danger
                      disabled={busy}
                      onPress={() => onOp({ op: "delete", name: active.name })}
                    />
                    <BranchAction
                      label="Force delete"
                      hint={`git branch -D ${active.name}`}
                      colors={colors}
                      danger
                      disabled={busy}
                      onPress={() => onOp({ op: "delete", name: active.name, force: true })}
                    />
                  </>
                )
              ) : (
                <BranchAction
                  label={active.remote ? "Delete remote branch…" : "Delete branch…"}
                  hint={active.remote ? "git push --delete" : "git branch -d"}
                  colors={colors}
                  danger
                  disabled={busy}
                  onPress={() => {
                    setConfirm("delete");
                    setRenaming(false);
                  }}
                />
              )
            ) : null}
          </ScrollView>
        ) : (
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 412 }}>
            <View style={{ paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4 }}>
              <TextInput
                value={filter}
                onChangeText={setFilter}
                placeholder="Search branches"
                placeholderTextColor={colors.fgMuted}
                autoFocus
                editable={!busy}
                style={{
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
            </View>
            <Text style={{ color: colors.fgMuted, fontSize: 10, paddingHorizontal: 12, paddingBottom: 4 }}>
              Click to preview · right-click or ⋯ to act
            </Text>
            <Pressable
              onPress={() => {
                setCreating((v) => !v);
                setActive(null);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Text style={{ color: colors.fg, fontSize: 12, fontWeight: "600" }}>+ Create branch…</Text>
            </Pressable>
            {creating ? (
              <View style={{ paddingHorizontal: 10, paddingBottom: 8, gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    placeholder="branch-name"
                    placeholderTextColor={colors.fgMuted}
                    autoFocus
                    editable={!busy}
                    onSubmitEditing={() => {
                      const n = newName.trim();
                      if (n) onOp({ op: "create", name: n, checkOut: checkOutNew });
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
                      if (n) onOp({ op: "create", name: n, checkOut: checkOutNew });
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
                <Pressable
                  onPress={() => setCheckOutNew((v) => !v)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 2 }}
                >
                  <Text style={{ color: colors.fg, fontSize: 12 }}>{checkOutNew ? "☑" : "☐"} Check out after create</Text>
                </Pressable>
              </View>
            ) : null}

            {filtered.locals.length > 0 ? <BranchSectionLabel label="Local" colors={colors} /> : null}
            {filtered.locals.map((h) => (
              <BranchListRow
                key={`local:${h.name}`}
                name={h.name}
                color={tintFor(h.name)}
                isCurrent={h.isCurrent}
                remote={false}
                previewing={preview === h.name}
                colors={colors}
                onPrimary={() => onPreview(h.name)}
                onMore={() => openActions(h)}
              />
            ))}
            {filtered.remoteHeads.length > 0 ? <BranchSectionLabel label="Remote" colors={colors} /> : null}
            {filtered.remoteHeads.map((h) => (
              <BranchListRow
                key={`remote:${h.name}`}
                name={h.name}
                color={tintFor(h.name)}
                isCurrent={false}
                remote
                previewing={preview === h.name}
                colors={colors}
                onPrimary={() => onPreview(h.name)}
                onMore={() => openActions(h)}
              />
            ))}
            {filtered.locals.length === 0 && filtered.remoteHeads.length === 0 ? (
              <Text style={{ color: colors.fgMuted, fontSize: 12, paddingHorizontal: 12, paddingVertical: 10 }}>
                No matching branches
              </Text>
            ) : null}
          </ScrollView>
        )}
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
  onOpenMenu,
}: {
  file: CommitDetailOutput["files"][number];
  expanded: boolean;
  colors: { fg: string; fgMuted: string; added: string; removed: string; border: string; accent: string; hoverBg: string };
  onToggle: () => void;
  onOpenMenu: (path: string, pageX: number, pageY: number) => void;
}) {
  const statusLabel =
    file.status === "?"
      ? "?"
      : file.status === "A" || file.status === "C"
        ? "A"
        : file.status === "D"
          ? "D"
          : file.status === "R"
            ? "R"
            : "M";
  const statusColor =
    file.status === "A" || file.status === "C" || file.status === "?"
      ? colors.added
      : file.status === "D"
        ? colors.removed
        : file.status === "R"
          ? colors.accent
          : colors.fgMuted;
  const [hovered, setHovered] = useState(false);
  const openMenu = (pageX: number, pageY: number) => {
    onOpenMenu(file.path, pageX, pageY);
  };
  return (
    <Pressable
      onPress={onToggle}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onLongPress={(e) => openMenu(e.nativeEvent.pageX, e.nativeEvent.pageY)}
      {...bindContextMenu(openMenu)}
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
  onOpenFileMenu,
  graphW,
}: {
  directory: string;
  hash: string;
  theme: PluginWorkspacePanelProps["theme"];
  expandedFile: string | null;
  onToggleFile: (path: string) => void;
  onOpenFileMenu: (path: string, pageX: number, pageY: number) => void;
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
          {detail.email ? (
            <Text style={{ color: colors.fgMuted, fontSize: 11 }}> &lt;{detail.email}&gt;</Text>
          ) : null}
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
              onOpenMenu={onOpenFileMenu}
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

/** Expanded diff between two arbitrary commits (ctrl/cmd-click pair). */
function CompareExpansion({
  directory,
  base,
  head,
  theme,
  expandedFile,
  onToggleFile,
  onOpenFileMenu,
  graphW,
}: {
  directory: string;
  base: GitTreeRow;
  head: GitTreeRow;
  theme: PluginWorkspacePanelProps["theme"];
  expandedFile: string | null;
  onToggleFile: (path: string) => void;
  onOpenFileMenu: (path: string, pageX: number, pageY: number) => void;
  graphW: number;
}) {
  const getCompare = useRpc(commitCompare);
  const getCompareDiff = useRpc(commitCompareDiff);
  const [result, setResult] = useState<CommitCompareOutput | null>(null);
  const [diff, setDiff] = useState<CommitCompareDiffOutput | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    getCompare({ directory, base: base.hash, head: head.hash })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [directory, base.hash, head.hash, getCompare]);

  useEffect(() => {
    if (!expandedFile) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    getCompareDiff({ directory, base: base.hash, head: head.hash, path: expandedFile })
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDiff({ patch: "", error: "Failed to load diff" });
      });
    return () => {
      cancelled = true;
    };
  }, [directory, base.hash, head.hash, expandedFile, getCompareDiff]);

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

  if (!result) {
    return (
      <Text style={{ color: colors.fgMuted, fontSize: 12, paddingVertical: 10, paddingRight: 10, marginLeft: graphW }}>
        Loading…
      </Text>
    );
  }
  if (result.error) {
    return (
      <Text style={{ color: colors.removed, fontSize: 12, paddingVertical: 10, paddingRight: 10, marginLeft: graphW }}>
        {result.error}
      </Text>
    );
  }

  return (
    <View style={{ marginLeft: graphW, paddingTop: 8, paddingBottom: 12, paddingRight: 12, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: colors.fg, fontSize: 12, fontFamily: "monospace" }}>{base.shortHash}</Text>
        <Icon name="ArrowRight" size={11} color={colors.fgMuted} />
        <Text style={{ color: colors.fg, fontSize: 12, fontFamily: "monospace" }}>{head.shortHash}</Text>
        <Text style={{ color: colors.fgMuted, fontSize: 11 }}>
          {result.files.length} file{result.files.length === 1 ? "" : "s"} differ
        </Text>
      </View>
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
        {result.files.map((file) => (
          <View key={file.path}>
            <FileRow
              file={file}
              colors={colors}
              expanded={expandedFile === file.path}
              onToggle={() => onToggleFile(file.path)}
              onOpenMenu={onOpenFileMenu}
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
  added: string;
  removed: string;
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
  compareBase,
  compareTarget,
  onToggle,
  onCompareClick,
  onToggleFile,
  directory,
  theme,
  onOpenMenu,
  onShowTip,
  onHideTip,
  onHeight,
  tintFor,
  onOpenFileMenu,
  onPreviewBranch,
  onOpenBranchMenu,
  heads,
  remotes,
}: {
  row: GitTreeRow;
  prevRow: GitTreeRow | undefined;
  index: number;
  graphW: number;
  colors: RowColors;
  compact: boolean;
  expanded: boolean;
  expandedFile: string | null;
  /** Pending compare anchor row, if any. */
  compareBase: GitTreeRow | null;
  /** Second commit of the compare pair, compared against the anchor. */
  compareTarget: GitTreeRow | null;
  onToggle: (hash: string) => void;
  /** Ctrl/Cmd+click handler: picks or clears the compare pair. */
  onCompareClick: (row: GitTreeRow) => void;
  onToggleFile: (path: string) => void;
  directory: string;
  theme: PluginWorkspacePanelProps["theme"];
  onOpenMenu: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onShowTip: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onHideTip: () => void;
  onHeight: (index: number, height: number) => void;
  tintFor: (name: string) => string;
  onOpenFileMenu: (path: string, pageX: number, pageY: number) => void;
  onPreviewBranch: (name: string) => void;
  onOpenBranchMenu: (head: BranchHead, pageX: number, pageY: number) => void;
  heads: BranchHead[];
  remotes: string[];
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
  const isUncommitted = isUncommittedHash(row.hash);
  const isHead = headRef !== undefined || row.refs.includes("HEAD") || isUncommitted;
  const [hovered, setHovered] = useState(false);

  const rowBg = expanded
    ? colors.expandedBg
    : hovered
      ? colors.hoverBg
      : compareBase?.hash === row.hash || compareTarget?.hash === row.hash
        ? colors.selected
        : colors.cardBg;

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
        onPress={(e) => {
          const ne = e.nativeEvent as { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean };
          if (!isUncommitted && (ne.ctrlKey || ne.metaKey || ne.altKey)) onCompareClick(row);
          else onToggle(row.hash);
        }}
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
        {...bindContextMenu(openMenu)}
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
              const tint = tintFor(ref);
              return (
                <Pressable
                  key={ref}
                  onPress={(e) => {
                    (e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
                    onPreviewBranch(ref);
                  }}
                  onLongPress={(e) => {
                    (e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
                    onOpenBranchMenu(resolveHead(ref, heads, row.hash, remotes), e.nativeEvent.pageX, e.nativeEvent.pageY);
                  }}
                  {...bindContextMenu((pageX, pageY) =>
                    onOpenBranchMenu(resolveHead(ref, heads, row.hash, remotes), pageX, pageY),
                  )}
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
                </Pressable>
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
            {compareBase?.hash === row.hash ? (
              <View
                style={{
                  backgroundColor: colors.selected,
                  borderRadius: 4,
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderWidth: 1,
                  borderColor: colors.hairline,
                }}
              >
                <Text style={{ fontSize: 10, color: colors.fg, fontWeight: "700" }}>⇔ base</Text>
              </View>
            ) : null}
            {compareTarget?.hash === row.hash ? (
              <View
                style={{
                  backgroundColor: colors.selected,
                  borderRadius: 4,
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderWidth: 1,
                  borderColor: colors.hairline,
                }}
              >
                <Text style={{ fontSize: 10, color: colors.fg, fontWeight: "700" }}>⇔ target</Text>
              </View>
            ) : null}
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
            {isUncommitted && row.author ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
                {row.author.split("  ·  ").map((part, i) => {
                  const added = part.startsWith("+");
                  const removed = part.startsWith("−") || part.startsWith("-");
                  return (
                    <Text
                      key={`${part}-${i}`}
                      numberOfLines={1}
                      style={{
                        color: added ? colors.added : removed ? colors.removed : colors.fgMuted,
                        fontSize: 10,
                        fontFamily: added || removed ? "monospace" : undefined,
                        fontWeight: added || removed ? "600" : "400",
                      }}
                    >
                      {part}
                    </Text>
                  );
                })}
              </View>
            ) : row.author ? (
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
            onOpenFileMenu={onOpenFileMenu}
            graphW={graphW}
          />
        </View>
      ) : null}
      {compareTarget?.hash === row.hash && compareBase ? (
        <View>
          <View style={{ height: 1, backgroundColor: colors.hairline, marginLeft: graphW }} />
          <CompareExpansion
            directory={directory}
            base={compareBase}
            head={compareTarget}
            theme={theme}
            expandedFile={expandedFile}
            onToggleFile={onToggleFile}
            onOpenFileMenu={onOpenFileMenu}
            graphW={graphW}
          />
        </View>
      ) : null}
      </View>
      <View style={{ height: CARD_GAP }} />
      {isUncommitted ? null : <GraphSlice row={row} prevRow={prevRow} height={sliceH} graphW={graphW} />}
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
  compareBase,
  compareTarget,
  onCompareClick,
  uncommitted,
  directory,
  theme,
  onToggle,
  onToggleFile,
  onOpenMenu,
  onShowTip,
  onHideTip,
  onScrollDismiss,
  tintFor,
  onOpenFileMenu,
  onPreviewBranch,
  onOpenBranchMenu,
  heads,
  remotes,
}: {
  rows: GitTreeRow[];
  graphW: number;
  colors: RowColors;
  compact: boolean;
  expandedHash: string | null;
  expandedFile: string | null;
  compareBase: GitTreeRow | null;
  compareTarget: GitTreeRow | null;
  onCompareClick: (row: GitTreeRow) => void;
  uncommitted: GitTreeOutput["uncommitted"];
  directory: string;
  theme: PluginWorkspacePanelProps["theme"];
  onToggle: (hash: string) => void;
  onToggleFile: (path: string) => void;
  onOpenMenu: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onShowTip: (row: GitTreeRow, pageX: number, pageY: number) => void;
  onHideTip: () => void;
  onScrollDismiss: () => void;
  tintFor: (name: string) => string;
  onOpenFileMenu: (path: string, pageX: number, pageY: number) => void;
  onPreviewBranch: (name: string) => void;
  onOpenBranchMenu: (head: BranchHead, pageX: number, pageY: number) => void;
  heads: BranchHead[];
  remotes: string[];
}) {
  const listRows = useMemo(
    () => (uncommitted ? [uncommittedRow(uncommitted), ...rows] : rows),
    [rows, uncommitted],
  );
  const expandedIndex = useMemo(
    () =>
      compareTarget
        ? listRows.findIndex((r) => r.hash === compareTarget.hash)
        : expandedHash
          ? listRows.findIndex((r) => r.hash === expandedHash)
          : -1,
    [listRows, expandedHash, compareTarget],
  );
  const [collapsedH, setCollapsedH] = useState(COLLAPSED_ROW_H);
  const [expandedH, setExpandedH] = useState(COLLAPSED_ROW_H);
  const collapsedLocked = useRef(false);
  const expandedIndexRef = useRef(expandedIndex);
  expandedIndexRef.current = expandedIndex;
  const viewportRef = useRef(0);
  const scrollYRef = useRef(0);
  const rangeRef = useRef({ start: 0, end: Math.min(listRows.length, LIST_OVERSCAN * 2 + 12) });
  const [, setRange] = useState(rangeRef.current);

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
  }, [listRows]);

  useEffect(() => {
    setExpandedH(COLLAPSED_ROW_H);
  }, [expandedHash]);

  useEffect(() => {
    applyRange(scrollYRef.current, viewportRef.current, listRows.length, expandedIndex, expandedH, collapsedH);
  }, [applyRange, listRows.length, expandedIndex, expandedH, collapsedH]);

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
  const totalH = LIST_PAD_Y * 2 + listRows.length * collapsedH + extra;

  // Derive the window from the current list on every render. Range state can
  // lag a shrink (path filter / scope change) by one frame, and reading
  // listRows[i].hash past the new length is what crashed the panel.
  const count = listRows.length;
  const vis = windowRange(
    scrollYRef.current,
    viewportRef.current,
    count,
    collapsedH,
    expandedIndex,
    expandedH,
  );
  const indices: number[] = [];
  for (let i = vis.start; i < vis.end; i++) {
    if (i >= 0 && i < count) indices.push(i);
  }
  if (expandedIndex >= 0 && expandedIndex < count && (expandedIndex < vis.start || expandedIndex >= vis.end)) {
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
        applyRange(scrollYRef.current, h, listRows.length, expandedIndex, expandedH, collapsedH);
      }}
      onScroll={(e) => {
        onScrollDismiss();
        const y = e.nativeEvent.contentOffset.y;
        scrollYRef.current = y;
        applyRange(y, viewportRef.current, listRows.length, expandedIndex, expandedH, collapsedH);
      }}
      scrollEventThrottle={16}
    >
      <View style={{ height: totalH, position: "relative" as const, overflow: "visible" as const }}
        onLayout={undefined}
      >
        {indices.map((i) => {
          const row = listRows[i];
          if (!row) return null;
          const prev = i > 0 ? listRows[i - 1] : undefined;
          return (
          <View
            key={`${row.hash}-${i}`}
            style={{
              position: "absolute" as const,
              top: itemOffset(i, collapsedH, expandedIndex, expandedH),
              left: 0,
              right: 0,
            }}
          >
            <CommitRow
              row={row}
              prevRow={prev && !isUncommittedHash(prev.hash) ? prev : undefined}
              index={i}
              graphW={graphW}
              colors={colors}
              compact={compact}
              expanded={expandedHash === row.hash}
              expandedFile={expandedHash === row.hash ? expandedFile : null}
              compareBase={compareBase}
              compareTarget={compareTarget}
              onToggle={onToggle}
              onCompareClick={onCompareClick}
              onToggleFile={onToggleFile}
              directory={directory}
              theme={theme}
              onOpenMenu={onOpenMenu}
              onShowTip={onShowTip}
              onHideTip={onHideTip}
              onHeight={onHeight}
              tintFor={tintFor}
              onOpenFileMenu={onOpenFileMenu}
              onPreviewBranch={onPreviewBranch}
              onOpenBranchMenu={onOpenBranchMenu}
              heads={heads}
              remotes={remotes}
            />
          </View>
          );
        })}
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
  const runCommit = useRpc(gitCommitOp);
  const toast = useToast();
  const shellRef = useRef<View>(null);
  const branchTriggerRef = useRef<View>(null);
  const scopeTriggerRef = useRef<View>(null);

  const directory = workspace?.directory ?? null;
  const [data, setData] = useState<GitTreeOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  /** "f:..." prefix routes the query to git log -- <path> on the server;
   *  anything else is a client-side text match. */
  const pathFilter = query.trim().match(/^f:\s*(.*)$/)?.[1]?.trim() ?? "";
  /** Debounced mirror of pathFilter — typing shouldn't spawn a git log per keypress. */
  const [debouncedPath, setDebouncedPath] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPath(pathFilter), 250);
    return () => clearTimeout(t);
  }, [pathFilter]);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  /** Ctrl/cmd-click compare pair. base is the anchor row; target the second
   *  commit; the CompareExpansion renders under the target row. */
  const [compareBase, setCompareBase] = useState<GitTreeRow | null>(null);
  const [compareTarget, setCompareTarget] = useState<GitTreeRow | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; row: GitTreeRow } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: GitTreeRow } | null>(null);
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; focus?: BranchHead } | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const menuOpen = useRef(false);
  const [scope, setScope] = useState<TreeScope>("current");
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  const previewHold = useRef<string | null>(null);
  previewHold.current = previewRef;
  const loadGen = useRef(0);
  const [scopeMenu, setScopeMenu] = useState<{ x: number; y: number } | null>(null);
  const [scopeHover, setScopeHover] = useState(false);
  const [refreshHover, setRefreshHover] = useState(false);
  const [pullHover, setPullHover] = useState(false);
  const [pushHover, setPushHover] = useState(false);
  const [searchHover, setSearchHover] = useState(false);
  const [branchHover, setBranchHover] = useState(false);

  const loadTree = useCallback(
    (opts?: { sync?: boolean; preview?: string | null }) => {
      if (!directory) return;
      const preview = opts && "preview" in opts ? opts.preview : previewHold.current;
      const id = ++loadGen.current;
      setLoading(true);
      getTree({
        directory,
        limit: COMMIT_LIMIT,
        scope,
        ...(debouncedPath ? { path: debouncedPath } : {}),
        ...(preview ? { preview } : {}),
        ...(opts?.sync ? { sync: true } : {}),
      })
        .then((next) => {
          if (id === loadGen.current) setData(next);
        })
        .catch(() => {
          if (id === loadGen.current) setData(null);
        })
        .finally(() => {
          if (id === loadGen.current) setLoading(false);
        });
    },
    [directory, getTree, scope, debouncedPath],
  );

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const refresh = useCallback(() => loadTree({ sync: true }), [loadTree]);

  const toggleCommit = useCallback((hash: string) => {
    setExpandedHash((cur) => (cur === hash ? null : hash));
    setExpandedFile(null);
    setCompareBase(null);
    setCompareTarget(null);
  }, []);

  /** Ctrl/cmd-click: first pick sets the anchor, second shows the comparison,
   *  clicking the anchor again clears the pair. */
  const handleCompareClick = useCallback(
    (row: GitTreeRow) => {
      setExpandedHash(null);
      setExpandedFile(null);
      if (compareTarget || !compareBase) {
        setCompareBase(row);
        setCompareTarget(null);
        return;
      }
      if (compareBase.hash === row.hash) {
        setCompareBase(null);
        setCompareTarget(null);
        return;
      }
      setCompareTarget(row);
    },
    [compareBase, compareTarget],
  );

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
    setFileMenu(null);
    setBranchMenu(null);
    setScopeMenu(null);
  }, []);

  const handleOpenMenu = useCallback(
    (row: GitTreeRow, pageX: number, pageY: number) => {
      menuOpen.current = true;
      setTip(null);
      setFileMenu(null);
      setBranchMenu(null);
      setScopeMenu(null);
      placeAt(pageX, pageY, 288, 380, (x, y) => setMenu({ x, y, row }));
    },
    [placeAt],
  );

  const handleOpenFileMenu = useCallback(
    (path: string, pageX: number, pageY: number) => {
      menuOpen.current = true;
      setTip(null);
      setMenu(null);
      setBranchMenu(null);
      setScopeMenu(null);
      placeAt(pageX, pageY, 240, 92, (x, y) => setFileMenu({ x, y, path }));
    },
    [placeAt],
  );

  const handleShowTip = useCallback(
    (row: GitTreeRow, pageX: number, pageY: number) => {
      if (menuOpen.current || branchMenu || scopeMenu || fileMenu) return;
      placeAt(pageX, pageY, 308, 88, (x, y) => setTip({ x, y, row }));
    },
    [placeAt, branchMenu, scopeMenu, fileMenu],
  );

  const handleHideTip = useCallback(() => setTip(null), []);

  const openBranchMenu = useCallback(() => {
    if (branchMenu) {
      setBranchMenu(null);
      return;
    }
    menuOpen.current = false;
    setMenu(null);
    setTip(null);
    setScopeMenu(null);
    setFileMenu(null);
    const node = branchTriggerRef.current;
    if (!node || typeof node.measureInWindow !== "function") {
      setBranchMenu({ x: 8, y: 40 });
      return;
    }
    node.measureInWindow((x, y, _w, h) => {
      placeAt(x, y + h + 6, 308, 420, (lx, ly) => setBranchMenu({ x: lx, y: ly }));
    });
  }, [branchMenu, placeAt]);

  const openScopeMenu = useCallback(() => {
    if (scopeMenu) return;
    menuOpen.current = false;
    setMenu(null);
    setTip(null);
    setBranchMenu(null);
    setFileMenu(null);
    const node = scopeTriggerRef.current;
    if (!node || typeof node.measureInWindow !== "function") {
      setScopeMenu({ x: 8, y: 40 });
      return;
    }
    node.measureInWindow((x, y, _w, h) => {
      placeAt(x, y + h + 6, 220, 180, (lx, ly) => setScopeMenu({ x: lx, y: ly }));
    });
  }, [scopeMenu, placeAt]);

  const handleBranchOp = useCallback(
    (req: BranchOpRequest) => {
      const op = req.op;
      if (op === "copy") {
        if (!req.name) return;
        void copyToClipboard(req.name).then((ok) => {
          if (ok) toast.show("Copied branch name");
          else toast.error("Couldn't copy");
        });
        return;
      }
      if (!directory || branchBusy) return;
      setBranchBusy(true);
      void runBranch({
        directory,
        op,
        name: req.name,
        newName: req.newName,
        force: req.force,
        checkOut: req.checkOut,
      })
        .then((result) => {
          if (result.error) {
            toast.error(result.error);
            return;
          }
          const done: Record<GitBranchOp, string> = {
            checkout: req.name ? `Switched to ${req.name}` : "Checked out",
            merge: req.name ? `Merged ${req.name}` : "Merged",
            delete: req.name ? `Deleted ${req.name}` : "Deleted",
            pull: req.name ? `Pulled ${req.name}` : "Pulled",
            create: req.name ? `Created ${req.name}` : "Created branch",
            rename: req.newName ? `Renamed to ${req.newName}` : "Renamed",
            rebase: req.name ? `Rebased onto ${req.name}` : "Rebased",
            push: req.force ? "Force pushed" : req.name ? `Pushed ${req.name}` : "Pushed",
            fetch: req.name ? `Fetched ${req.name}` : "Fetched",
          };
          toast.show(done[op]);
          const clearPreview = op === "checkout" || (op === "create" && req.checkOut !== false);
          if (clearPreview) {
            previewHold.current = null;
            setPreviewRef(null);
          }
          loadTree({ sync: true, ...(clearPreview ? { preview: null } : {}) });
          setBranchMenu(null);
        })
        .catch(() => toast.error("Git operation failed"))
        .finally(() => setBranchBusy(false));
    },
    [directory, branchBusy, runBranch, toast, loadTree],
  );

  const handlePreview = useCallback(
    (name: string) => {
      const next = previewHold.current === name ? null : name;
      previewHold.current = next;
      setPreviewRef(next);
      setBranchMenu(null);
      loadTree({ preview: next });
    },
    [loadTree],
  );

  const handleOpenBranchChip = useCallback(
    (head: BranchHead, pageX: number, pageY: number) => {
      menuOpen.current = true;
      setTip(null);
      setMenu(null);
      setFileMenu(null);
      setScopeMenu(null);
      placeAt(pageX, pageY, 308, 420, (x, y) => setBranchMenu({ x, y, focus: head }));
    },
    [placeAt],
  );

  const handleCommitOp = useCallback(
    (req: {
      op: GitCommitOp;
      hash: string;
      name?: string;
      mode?: "soft" | "mixed" | "hard";
      checkOut?: boolean;
    }) => {
      if (!directory || branchBusy) return;
      setBranchBusy(true);
      void runCommit({
        directory,
        op: req.op,
        hash: req.hash,
        name: req.name,
        mode: req.mode,
        checkOut: req.checkOut,
      })
        .then((result) => {
          if (result.error) {
            toast.error(result.error);
            return;
          }
          const done: Record<GitCommitOp, string> = {
            checkout: "Checked out commit",
            "cherry-pick": "Cherry-picked",
            revert: "Reverted",
            merge: "Merged commit",
            rebase: "Rebased onto commit",
            reset: req.mode === "hard" ? "Hard reset" : "Reset",
            tag: req.name ? `Tagged ${req.name}` : "Tagged",
            "create-branch": req.name ? `Created ${req.name}` : "Created branch",
          };
          toast.show(done[req.op]);
          const clearPreview =
            req.op === "checkout" ||
            req.op === "reset" ||
            (req.op === "create-branch" && req.checkOut !== false);
          if (clearPreview) {
            previewHold.current = null;
            setPreviewRef(null);
          }
          loadTree({ sync: true, ...(clearPreview ? { preview: null } : {}) });
          setMenu(null);
        })
        .catch(() => toast.error("Git operation failed"))
        .finally(() => setBranchBusy(false));
    },
    [directory, branchBusy, runCommit, toast, loadTree],
  );

  const colors: RowColors = useMemo(
    () => ({
      fg: theme.colors.foreground,
      fgMuted: theme.colors.foregroundMuted,
      success: theme.colors.statusSuccess,
      added: theme.colors.statusSuccess,
      removed: theme.colors.statusDanger,
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
  const remotes = data?.remotes ?? [];
  const queryTrim = query.trim().toLowerCase();
  const { rows, graphW } = useMemo(() => {
    // A path filter is resolved server-side (git log -- <path>); the rows we
    // get back are already the matching subset.
    if (!queryTrim || debouncedPath) return { rows: allRows, graphW: graphWidth(laneCountOf(allRows)) };
    const hits = allRows.filter(
      (r) =>
        r.subject.toLowerCase().includes(queryTrim) ||
        r.author.toLowerCase().includes(queryTrim) ||
        r.hash.toLowerCase().startsWith(queryTrim) ||
        r.refs.some((ref) => ref.toLowerCase().includes(queryTrim)),
    );
    // Recompute lanes on the filtered subset so the graph stays connected.
    const relaid = computeGraph(hits, remotes);
    return { rows: relaid, graphW: graphWidth(laneCountOf(relaid)) };
  }, [allRows, queryTrim, debouncedPath, remotes]);
  const refColors = useMemo(() => assignRefColors(rows, remotes), [rows, remotes]);
  const tintFor = useCallback((name: string) => tintForRef(name, refColors), [refColors]);
  const heads = data?.heads ?? [];
  const currentHead = heads.find((h) => h.isCurrent);
  const triggerName = currentHead?.name ?? (heads.length > 0 ? "HEAD" : null);
  const triggerColor = currentHead ? tintFor(currentHead.name) : theme.colors.foregroundMuted;

  return (
    <View ref={shellRef} style={styles.screen} {...hostMenuBlock}>
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
          <Text style={styles.title}>Git Tree</Text>
          {previewRef || rows.length > 0 ? (
            <Text style={styles.subtitle}>
              {previewRef
                ? `previewing ${previewRef}${rows.length > 0 ? ` · ${rows.length} commit${rows.length === 1 ? "" : "s"}` : ""}`
                : queryTrim
                  ? pathFilter
                    ? `commits touching "${pathFilter}"…`
                    : `${rows.length} of ${allRows.length} commits match "${query.trim()}"`
                  : `${rows.length} commit${rows.length === 1 ? "" : "s"}`}
            </Text>
          ) : null}
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
        <View ref={scopeTriggerRef}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Filter refs"
            onPress={openScopeMenu}
            onHoverIn={() => setScopeHover(true)}
            onHoverOut={() => setScopeHover(false)}
            hitSlop={8}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              paddingHorizontal: 6,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: scopeHover || scopeMenu || scope !== "all" ? theme.colors.surface1 : "transparent",
            }}
          >
            <Icon
              name="Filter"
              size={14}
              color={scope !== "all" || scopeMenu ? theme.colors.accent : theme.colors.foreground}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: scope !== "all" ? "700" : "500",
                color: scope !== "all" || scopeMenu ? theme.colors.accent : theme.colors.foregroundMuted,
              }}
            >
              {SCOPE_OPTIONS.find((o) => o.value === scope)?.short ?? "All"}
            </Text>
          </Pressable>
        </View>
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
        {currentHead && !currentHead.remote ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pull"
              disabled={branchBusy}
              onPress={() => handleBranchOp({ op: "pull" })}
              onHoverIn={() => setPullHover(true)}
              onHoverOut={() => setPullHover(false)}
              hitSlop={8}
              style={{
                padding: 6,
                borderRadius: 6,
                backgroundColor: pullHover ? theme.colors.surface1 : "transparent",
                opacity: branchBusy ? 0.45 : 1,
              }}
            >
              <Icon
                name="ArrowDownToLine"
                size={14}
                color={theme.colors.foreground}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Push"
              disabled={branchBusy || remotes.length === 0}
              onPress={() => handleBranchOp({ op: "push", name: currentHead.name })}
              onHoverIn={() => setPushHover(true)}
              onHoverOut={() => setPushHover(false)}
              hitSlop={8}
              style={{
                padding: 6,
                borderRadius: 6,
                backgroundColor: pushHover ? theme.colors.surface1 : "transparent",
                opacity: branchBusy || remotes.length === 0 ? 0.45 : 1,
              }}
            >
              <Icon
                name="ArrowUpFromLine"
                size={14}
                color={theme.colors.foreground}
              />
            </Pressable>
          </>
        ) : null}
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
            placeholder="Search message/author/hash · f: <path> filters by file"
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
          compareBase={compareBase}
          compareTarget={compareTarget}
          onCompareClick={handleCompareClick}
          uncommitted={
            previewRef && previewRef !== currentHead?.name ? null : (data?.uncommitted ?? null)
          }
          directory={directory ?? ""}
          theme={theme}
          onToggle={toggleCommit}
          onToggleFile={toggleFile}
          onOpenMenu={handleOpenMenu}
          onShowTip={handleShowTip}
          onHideTip={handleHideTip}
          onScrollDismiss={dismissFloats}
          tintFor={tintFor}
          onOpenFileMenu={handleOpenFileMenu}
          onPreviewBranch={handlePreview}
          onOpenBranchMenu={handleOpenBranchChip}
          heads={heads}
          remotes={remotes}
        />
      )}

      {tip && !menu && !fileMenu && !branchMenu && !scopeMenu ? (
        <CommitTip x={tip.x} y={tip.y} row={tip.row} colors={floatColors} />
      ) : null}
      {menu ? (
        <CommitMenu
          x={menu.x}
          y={menu.y}
          row={menu.row}
          currentName={currentHead && !currentHead.remote ? currentHead.name : null}
          colors={floatColors}
          busy={branchBusy}
          onDismiss={() => {
            menuOpen.current = false;
            setMenu(null);
          }}
          onAct={handleCommitOp}
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
      {fileMenu ? (
        <FileMenu
          x={fileMenu.x}
          y={fileMenu.y}
          path={fileMenu.path}
          colors={floatColors}
          onDismiss={() => {
            menuOpen.current = false;
            setFileMenu(null);
          }}
          onFilter={() => {
            const path = fileMenu.path;
            menuOpen.current = false;
            setFileMenu(null);
            setSearching(true);
            setQuery(`f: ${path}`);
          }}
          onCopy={() => {
            const path = fileMenu.path;
            void copyToClipboard(path).then((ok) => {
              menuOpen.current = false;
              setFileMenu(null);
              if (ok) toast.show("Copied path");
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
          remotes={remotes}
          preview={previewRef}
          focus={branchMenu.focus}
          colors={floatColors}
          busy={branchBusy}
          tintFor={tintFor}
          onDismiss={() => setBranchMenu(null)}
          onPreview={handlePreview}
          onOp={handleBranchOp}
        />
      ) : null}
      {scopeMenu ? (
        <ScopeMenu
          x={scopeMenu.x}
          y={scopeMenu.y}
          scope={scope}
          colors={floatColors}
          onDismiss={() => setScopeMenu(null)}
          onSelect={(next) => {
            previewHold.current = null;
            setPreviewRef(null);
            setScope(next);
            setScopeMenu(null);
          }}
        />
      ) : null}
    </View>
  );
}
