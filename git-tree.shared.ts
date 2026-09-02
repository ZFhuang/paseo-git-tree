import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * One commit row of the computed branch graph.
 *
 * `lane` is the track the commit dot sits on. `edges` are the line segments
 * drawn across this row's vertical span: each goes from lane `from` at the top
 * of the row to lane `to` at the bottom — equal values render as a vertical
 * line, different values as a diagonal (branch out / merge in).
 */
export const rowSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  author: z.string(),
  /** ISO-8601 date. */
  date: z.string(),
  refs: z.array(z.string()),
  lane: z.number().int(),
  /** `fromTop: true` marks a segment that enters this row's dot from above
   *  (a lane converging into this commit); others leave the dot downwards. */
  edges: z.array(
    z.object({
      from: z.number().int(),
      to: z.number().int(),
      fromTop: z.boolean().default(false),
    }),
  ),
});

export const gitTree = defineRpc({
  name: "gittree.get",
  input: z.object({
    directory: z.string().min(1),
    limit: z.number().int().positive().max(2000).default(300),
  }),
  output: z.object({
    rows: z.array(rowSchema),
    heads: z.array(
      z.object({
        name: z.string(),
        hash: z.string(),
        isCurrent: z.boolean(),
      }),
    ),
    /** Human-readable failure reason; null when data is usable. */
    error: z.string().nullable(),
  }),
});

export type GitTreeOutput = z.output<typeof gitTree.output>;
export type GitTreeRow = z.output<typeof rowSchema>;

/** Full detail for one commit, including changed files with stats. */
export const commitDetail = defineRpc({
  name: "gittree.commit",
  input: z.object({
    directory: z.string().min(1),
    hash: z.string().min(1),
  }),
  output: z.object({
    hash: z.string(),
    author: z.string(),
    email: z.string(),
    date: z.string(),
    subject: z.string(),
    body: z.string(),
    parents: z.array(z.string()),
    files: z.array(
      z.object({
        path: z.string(),
        status: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
    error: z.string().nullable(),
  }),
});

export type CommitDetailOutput = z.output<typeof commitDetail.output>;

/** Unified diff of one file in one commit (vs first parent for merges). */
export const commitDiff = defineRpc({
  name: "gittree.diff",
  input: z.object({
    directory: z.string().min(1),
    hash: z.string().min(1),
    path: z.string().min(1),
  }),
  output: z.object({
    patch: z.string(),
    error: z.string().nullable(),
  }),
});

export type CommitDiffOutput = z.output<typeof commitDiff.output>;
