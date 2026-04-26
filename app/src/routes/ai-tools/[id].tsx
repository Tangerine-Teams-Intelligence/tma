/**
 * /ai-tools/:id — route entry. Thin wrapper around the generic
 * <AIToolSetupPage/> component, which reads `:id` from the router itself.
 *
 * One file per tool would be 10x duplication for zero gain — every tool
 * shares the same shell (status banner + 3 setup steps + 3 test queries),
 * driven by `lib/ai-tools-config.ts`.
 */

export { default } from "@/components/ai-tools/AIToolSetupPage";
