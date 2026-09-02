import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  commitDetail,
  commitDiff,
  gitTree,
  type CommitDetailOutput,
  type CommitDiffOutput,
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
  const statusLabel = file.status === "A" ? "A" : file.status === "D" ? "D" : "M";
  const statusColor =
    file.status === "A" ? colors.added : file.status === "D" ? colors.removed : colors.fgMuted;
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

function CommitRow({
  row,
  prevRow,
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
}: {
  row: GitTreeRow;
  prevRow: GitTreeRow | undefined;
  graphW: number;
  colors: {
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
  compact: boolean;
  expanded: boolean;
  expandedFile: string | null;
  onToggle: () => void;
  onToggleFile: (path: string) => void;
  directory: string;
  theme: PluginWorkspacePanelProps["theme"];
  onOpenMenu: (pageX: number, pageY: number) => void;
  onShowTip: (pageX: number, pageY: number) => void;
  onHideTip: () => void;
}) {
  const cardRef = useRef<View>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sliceH, setSliceH] = useState(ROW_HEIGHT + CARD_BORDER * 2 + CARD_GAP);

  useEffect(
    () => () => {
      if (tipTimer.current) clearTimeout(tipTimer.current);
    },
    [],
  );

  const headRef = row.refs.find((r) => r.startsWith("HEAD ->"));
  const branchRefs = row.refs.filter(
    (r) => !r.startsWith("HEAD ->") && r !== "HEAD" && !r.startsWith("tag:"),
  );
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
        onShowTip(x + Math.min(w * 0.35, 140), y + h + 6);
      });
    }, 380);
  };

  const openMenu = (pageX: number, pageY: number) => {
    clearTipTimer();
    onHideTip();
    onOpenMenu(pageX, pageY);
  };

  return (
    <View
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0) setSliceH(h);
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
        onPress={onToggle}
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
            {branchRefs.slice(0, 2).map((ref) => (
              <View
                key={ref}
                style={{
                  backgroundColor: isHead ? colors.success + "33" : colors.chipBg,
                  borderRadius: 4,
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderWidth: 1,
                  borderColor: isHead ? colors.success + "66" : colors.ring,
                }}
              >
                <Text numberOfLines={1} style={{ fontSize: 10, color: colors.fg, fontWeight: isHead ? "600" : "500" }}>
                  {ref}
                </Text>
              </View>
            ))}
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
              {row.date ? row.date.slice(0, 10) : ""}
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
}

// --- Panel ----------------------------------------------------------------------

export function GitTreePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (w) => ({
    directory: w.directory,
    name: w.name,
    projectKind: w.projectKind,
  }));
  const getTree = useRpc(gitTree);
  const toast = useToast();
  const shellRef = useRef<View>(null);

  const directory = workspace?.directory ?? null;
  const [data, setData] = useState<GitTreeOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; row: GitTreeRow } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: GitTreeRow } | null>(null);
  const menuOpen = useRef(false);
  const [refreshHover, setRefreshHover] = useState(false);

  const refresh = useCallback(() => {
    if (!directory) return;
    setLoading(true);
    getTree({ directory, limit: 300 })
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [directory, getTree]);

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
  }, []);

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
      headsWrap: {
        paddingHorizontal: layout.compact ? 10 : 14,
        paddingVertical: 8,
        gap: 6,
        flexWrap: "wrap" as const,
        flexDirection: "row" as const,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border + "66",
      },
      headChip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border + "40",
      },
      headChipCurrent: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.statusSuccess + "88",
      },
      headChipText: { fontSize: 10, color: theme.colors.foregroundMuted },
      headChipTextCurrent: { color: theme.colors.foreground, fontWeight: "600" as const },
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

  const rows = data?.rows ?? [];
  const graphW = graphWidth(laneCountOf(rows));
  const heads = data?.heads ?? [];
  const colors = {
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
  };

  const floatColors: FloatColors = {
    fg: theme.colors.foreground,
    fgMuted: theme.colors.foregroundMuted,
    surface: theme.colors.surface2,
    ring: theme.colors.border + "66",
    hover: theme.colors.surface1,
  };

  return (
    <View ref={shellRef} style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Git Tree</Text>
          {rows.length > 0 ? (
            <Text style={styles.subtitle}>
              {rows.length} commit{rows.length === 1 ? "" : "s"}
            </Text>
          ) : null}
        </View>
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

      {heads.length > 0 ? (
        (() => {
          const current = heads.find((h) => h.isCurrent);
          const others = heads.filter((h) => !h.isCurrent).slice(0, 5);
          const remaining = heads.length - 1 - others.length;
          return (
            <View style={styles.headsWrap}>
              {current ? (
                <View key={current.name} style={[styles.headChip, styles.headChipCurrent]}>
                  <Icon name="CircleDot" size={10} color={theme.colors.statusSuccess} />
                  <Text style={[styles.headChipText, styles.headChipTextCurrent]}>{current.name}</Text>
                </View>
              ) : null}
              {others.map((h) => (
                <View key={h.name} style={styles.headChip}>
                  <Icon name="GitBranch" size={10} color={theme.colors.foregroundMuted} />
                  <Text style={styles.headChipText}>{h.name}</Text>
                </View>
              ))}
              {remaining > 0 ? (
                <View key="__more" style={styles.headChip}>
                  <Text style={styles.headChipText}>+{remaining} more</Text>
                </View>
              ) : null}
            </View>
          );
        })()
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
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 8 }}
          onScroll={dismissFloats}
          scrollEventThrottle={64}
        >
          <View style={{ position: "relative" as const, overflow: "visible" as const }}>
            {rows.map((row, i) => (
              <CommitRow
                key={`${row.hash}-${i}`}
                row={row}
                prevRow={i > 0 ? rows[i - 1] : undefined}
                graphW={graphW}
                colors={colors}
                compact={layout.compact}
                expanded={expandedHash === row.hash}
                expandedFile={expandedHash === row.hash ? expandedFile : null}
                onToggle={() => toggleCommit(row.hash)}
                onToggleFile={toggleFile}
                directory={directory ?? ""}
                theme={theme}
                onOpenMenu={(pageX, pageY) => {
                  menuOpen.current = true;
                  setTip(null);
                  placeAt(pageX, pageY, 208, 92, (x, y) => setMenu({ x, y, row }));
                }}
                onShowTip={(pageX, pageY) => {
                  if (menuOpen.current) return;
                  placeAt(pageX, pageY, 308, 88, (x, y) => setTip({ x, y, row }));
                }}
                onHideTip={() => setTip(null)}
              />
            ))}
          </View>
        </ScrollView>
      )}

      {tip && !menu ? <CommitTip x={tip.x} y={tip.y} row={tip.row} colors={floatColors} /> : null}
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
    </View>
  );
}
