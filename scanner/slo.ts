import { Temporal } from "@js-temporal/polyfill";
import { SloType } from '@lib/repo-summaries.js';
import assert from "node:assert";
import type { IssueOrPr, Repository } from "./github.js";
import { hasTriagePredicate, isTriaged } from "./per-repo.js";

const PRIORITY_URGENT = "priority: urgent";
const PRIORITY_SOON = "priority: soon";
const PRIORITY_EVENTUALLY = "priority: eventually";
const AGENDA = "agenda+";
const NEEDS_EDITS = "needs edits";
const NEEDS_REPORTER_FEEDBACK = "needs reporter feedback";
export function NeedsReporterFeedback(label: string) {
  return label.toLowerCase() === NEEDS_REPORTER_FEEDBACK;
}

const sloLabels = {
  agenda: AGENDA,
  needsEdits: NEEDS_EDITS,
} as const;

/** Returns whether `repo` has enough labels or configuration to mark bugs as triaged.
 *
 * Because different repositories will adopt different subsets of the labels this tool recognizes,
 * we should only look for the smallest subset that indicates the repo isn't relying on the triage
 * heuristics. For now, that's just the `Priority: Eventually` label.
 *
 * It's also possible to define a custom isTriaged predicate for each repository.
 */
export function hasLabels(repo: Pick<Repository, 'nameWithOwner' | 'labels'>): boolean {
  return hasTriagePredicate(repo.nameWithOwner) || repo.labels.nodes.some(labelNode => labelNode.name.toLowerCase() === PRIORITY_EVENTUALLY);
}

export function whichSlo(repoNameWithOwner: string, issue: Pick<IssueOrPr, 'labels' | 'isDraft'>): SloType {
  const labels: string[] = issue.labels.nodes.map(label => label.name.toLowerCase());
  if (issue.isDraft || labels.includes(NEEDS_REPORTER_FEEDBACK)) {
    return "none";
  }
  if (labels.includes(PRIORITY_URGENT)) {
    return "urgent";
  }
  if (labels.includes(PRIORITY_SOON)) {
    return "soon";
  }
  if (labels.includes(PRIORITY_EVENTUALLY) || isTriaged(repoNameWithOwner, issue)) {
    return "none";
  }
  return "triage";
}

function anyLabelAppliesSlo(labelsLowercase: Set<string>, slo: SloType): boolean {
  let acceptedLabels: string[];
  switch (slo) {
    case "none": return false;
    case "triage": return true;
    case "soon":
      acceptedLabels = [PRIORITY_SOON, PRIORITY_URGENT]
      break;
    case "urgent":
      acceptedLabels = [PRIORITY_URGENT];
      break;
  }
  return acceptedLabels.some(label => labelsLowercase.has(label));
}

export function countSloTime(
  issue: Pick<IssueOrPr, 'createdAt' | 'author' | 'timelineItems'>,
  now: Temporal.Instant,
  slo: SloType,
): Temporal.Duration {
  let timeUsed = Temporal.Duration.from({ seconds: 0 });
  type PauseReason = "draft" | "need-feedback" | "closed" | "no-slo-label";
  const pauseReason = new Set<PauseReason>();
  const activeLabelsLowercase = new Set<string>();
  if (!anyLabelAppliesSlo(activeLabelsLowercase, slo)) {
    pauseReason.add("no-slo-label");
  }
  let draftChanged = false;
  let sloStartTime = Temporal.Instant.from(issue.createdAt);

  for (const timelineItem of issue.timelineItems.nodes) {
    function pause(reason: PauseReason) {
      if (pauseReason.size === 0) {
        timeUsed = timeUsed.add(sloStartTime.until(timelineItem.createdAt!));
      }
      pauseReason.add(reason);
    }
    function unpause(reason: PauseReason) {
      const deleted = pauseReason.delete(reason);
      if (pauseReason.size === 0 && deleted) {
        sloStartTime = Temporal.Instant.from(timelineItem.createdAt!);
      }
    }
    switch (timelineItem.__typename) {
      case 'ReadyForReviewEvent':
        if (!draftChanged) {
          // If the first change in draft status is to become ready for review, then the SLO must
          // have been paused for all previous events.
          timeUsed = Temporal.Duration.from({ seconds: 0 });
          sloStartTime = Temporal.Instant.from(timelineItem.createdAt!);
          draftChanged = true;
        }
        unpause("draft");
        break;
      case 'ConvertToDraftEvent':
        draftChanged = true;
        pause("draft");
        break;
      case 'LabeledEvent':
        activeLabelsLowercase.add(timelineItem.label.name.toLowerCase());
        if (NeedsReporterFeedback(timelineItem.label.name)) {
          pause("need-feedback");
        }
        if (anyLabelAppliesSlo(activeLabelsLowercase, slo)) {
          unpause("no-slo-label");
        }
        break;
      case 'UnlabeledEvent':
        activeLabelsLowercase.delete(timelineItem.label.name.toLowerCase());
        if (NeedsReporterFeedback(timelineItem.label.name)) {
          unpause("need-feedback");
        }
        if (!anyLabelAppliesSlo(activeLabelsLowercase, slo)) {
          pause("no-slo-label");
        }
        break;
      case 'ClosedEvent':
        pause("closed");
        break;
      case 'ReopenedEvent':
        unpause("closed");
        break;
      case 'IssueComment':
      case 'PullRequestReview':
      case 'PullRequestReviewThread':
        if (timelineItem.author?.login === issue.author?.login) {
          unpause("need-feedback");
        }
        break;
    }
  }
  if (pauseReason.size === 0) {
    timeUsed = timeUsed.add(sloStartTime.until(now));
  }
  return timeUsed.round({ largestUnit: 'days' });
}


/**
 * Returns how long `issue` has had a given label, or `undefined` if it doesn't have that label.
 *
 * This counts from the most recent time that the label was added, since an issue can get this sort
 * of property multiple times, and it's not "late" this time just because the previous time took a
 * while to handle.
 */
export function countLabeledTime(issue: Pick<IssueOrPr, 'url' | 'labels' | 'timelineItems'>,
  labelId: keyof typeof sloLabels,
  now: Temporal.Instant): undefined | Temporal.Duration {
  const labelName = sloLabels[labelId]
  if (!issue.labels.nodes.some(label => label.name.toLowerCase() === labelName)) {
    return undefined;
  }
  const labelAddEvent = issue.timelineItems.nodes.findLast(timelineItem =>
    timelineItem.__typename === 'LabeledEvent' &&
    timelineItem.label.name.toLowerCase() === labelName);
  if (labelAddEvent === undefined) {
    throw new Error(
      `Issue ${issue.url} has the '${labelName}' label but no timeline item adding that label.`,
      { cause: issue });
  }
  assert.strictEqual(labelAddEvent.__typename, 'LabeledEvent');
  return labelAddEvent.createdAt.until(now).round({ largestUnit: 'days' });
}
