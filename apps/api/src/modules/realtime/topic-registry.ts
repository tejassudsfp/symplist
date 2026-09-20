import type {
  AuthorizedTopicKind,
  TopicAuthorizer,
  TopicSnapshotProvider,
  UserSnapshotContributor,
} from "@symplist/core/events";

/**
 * The seams features register with the gateway (§7): one ownership check and at most one snapshot
 * provider per topic kind, plus contributors to the `user` topic snapshot. Features register from
 * `onModuleInit`; a topic kind without an authorizer accepts no subscription (`not_found`).
 */
export class TopicRegistry {
  private readonly authorizers = new Map<AuthorizedTopicKind, TopicAuthorizer>();
  private readonly snapshots = new Map<AuthorizedTopicKind, TopicSnapshotProvider>();
  private readonly userContributors = new Map<string, UserSnapshotContributor>();

  registerAuthorizer<Kind extends AuthorizedTopicKind>(authorizer: TopicAuthorizer<Kind>): void {
    if (this.authorizers.has(authorizer.kind)) {
      throw new Error(`A ${authorizer.kind} topic authorizer is already registered`);
    }
    this.authorizers.set(authorizer.kind, authorizer as unknown as TopicAuthorizer);
  }

  registerSnapshotProvider<Kind extends AuthorizedTopicKind>(
    provider: TopicSnapshotProvider<Kind>,
  ): void {
    if (this.snapshots.has(provider.kind)) {
      throw new Error(`A ${provider.kind} snapshot provider is already registered`);
    }
    this.snapshots.set(provider.kind, provider as unknown as TopicSnapshotProvider);
  }

  registerUserSnapshotContributor(contributor: UserSnapshotContributor): void {
    if (this.userContributors.has(contributor.name)) {
      throw new Error(
        `A user snapshot contributor named ${contributor.name} is already registered`,
      );
    }
    this.userContributors.set(contributor.name, contributor);
  }

  authorizer(kind: AuthorizedTopicKind): TopicAuthorizer | undefined {
    return this.authorizers.get(kind);
  }

  snapshotProvider(kind: AuthorizedTopicKind): TopicSnapshotProvider | undefined {
    return this.snapshots.get(kind);
  }

  userSnapshotContributors(): readonly UserSnapshotContributor[] {
    return [...this.userContributors.values()];
  }
}
