"use client";
export interface HandoffController {
  copy(): void;
  readonly canCopy: boolean;
}
let active: HandoffController | null = null;
export function activeHandoff() {
  return active;
}
export function registerHandoff(value: HandoffController) {
  active = value;
  return () => {
    if (active === value) active = null;
  };
}

export interface ArtifactLinksController {
  readonly canRevoke: boolean;
  revoke(): void;
}
let links: ArtifactLinksController | null = null;
export function activeArtifactLinks() {
  return links;
}
export function registerArtifactLinks(value: ArtifactLinksController) {
  links = value;
  return () => {
    if (links === value) links = null;
  };
}
