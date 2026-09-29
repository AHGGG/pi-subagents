/**
 * Completion delivery is shared by individual, grouped and workflow-tool notices.
 *
 * On Pi 0.87.1, steering is drained AFTER the complete tool batch, before the
 * next model request. It does not abort tools or skip sequential batch members.
 * It also requests continuation after a text-only answer; followUp would delay
 * a notice until the active tool loop finishes. triggerTurn wakes an idle parent.
 *
 * This is not a cancellation policy: interrupting the parent alone does not
 * cancel detached children or permanently disable their later notifications.
 */
export const COMPLETION_DELIVERY_OPTIONS = Object.freeze({
  deliverAs: "steer",
  triggerTurn: true,
} as const);
