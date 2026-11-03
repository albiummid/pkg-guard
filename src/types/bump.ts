export type BumpKind = 'patch' | 'minor' | 'major';

export type BumpTargets = Partial<Record<BumpKind, string>>;
