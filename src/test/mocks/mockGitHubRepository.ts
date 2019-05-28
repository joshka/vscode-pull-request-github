import { SinonSandbox } from 'sinon';
import { QueryOptions, ApolloQueryResult, FetchResult, MutationOptions, NetworkStatus } from 'apollo-boost';

import { GitHubRepository } from '../../github/githubRepository';
import { QueryProvider } from './queryProvider';
import { Remote } from '../../common/remote';
import { CredentialStore } from '../../github/credentials';
import { RepositoryBuilder } from '../builders/rest/repoBuilder';
import { UserBuilder } from '../builders/rest/userBuilder';
import { ManagedGraphQLPullRequestBuilder, ManagedRESTPullRequestBuilder, ManagedPullRequest } from '../builders/managedPullRequestBuilder';
const queries = require('./queries.gql');

interface IMockGitHubRepositoryOptions {
	failAuthentication?: boolean;
	noGraphQL?: boolean;
}

export class MockGitHubRepository extends GitHubRepository {
	readonly queryProvider: QueryProvider;

	constructor(
		remote: Remote,
		credentialStore: CredentialStore,
		sinon: SinonSandbox,
		private _options: IMockGitHubRepositoryOptions = {},
	) {
		super(remote, credentialStore);

		this.queryProvider = new QueryProvider(sinon);

		this._hub = {
			octokit: this.queryProvider.octokit,
			graphql: null,
		};

		this._metadata = {
			...new RepositoryBuilder().build(),
			currentUser: new UserBuilder().build(),
		};

		this._initialized = true;
	}

	async ensure() {
		return this;
	}

	async authenticate() {
		return !this._options.failAuthentication;
	}

	get supportsGraphQl() {
		return !this._options.noGraphQL;
	}

	query = async <T>(query: QueryOptions): Promise<ApolloQueryResult<T>> => this.queryProvider.emulateGraphQLQuery(query);

	mutate = async <T>(mutation: MutationOptions): Promise<FetchResult<T>> => this.queryProvider.emulateGraphQLMutation(mutation);

	buildMetadata(
		block: (repoBuilder: RepositoryBuilder, userBuilder: UserBuilder) => void
	) {
		const repoBuilder = new RepositoryBuilder();
		const userBuilder = new UserBuilder();
		block(repoBuilder, userBuilder);
		this._metadata = {
			...repoBuilder.build(),
			currentUser: userBuilder.build(),
		};
	}

	addGraphQLPullRequest(block: (builder: ManagedGraphQLPullRequestBuilder) => void) {
		const builder = new ManagedGraphQLPullRequestBuilder();
		block(builder);
		const responses = builder.build();

		const prNumber = responses.pullRequest.repository.pullRequest.number;
		const headRef = responses.pullRequest.repository.pullRequest.headRef;

		this.queryProvider.expectGraphQLQuery({
			query: queries.PullRequest,
			variables: {
				owner: this.remote.owner,
				name: this.remote.repositoryName,
				number: prNumber,
			}
		}, {data: responses.pullRequest, loading: false, stale: false, networkStatus: NetworkStatus.ready});

		this.queryProvider.expectGraphQLQuery({
			query: queries.TimelineEvents,
			variables: {
				owner: this.remote.owner,
				name: this.remote.repositoryName,
				number: prNumber
			}
		}, {data: responses.timelineEvents, loading: false, stale: false, networkStatus: NetworkStatus.ready});

		this._addPullRequestCommon(prNumber, headRef && headRef.target.oid, responses);

		return this;
	}

	addRESTPullRequest(block: (builder: ManagedRESTPullRequestBuilder) => void) {
		const builder = new ManagedRESTPullRequestBuilder();
		block(builder);
		const responses = builder.build();

		const prNumber = responses.pullRequest.number;
		const headRef = responses.pullRequest.head.sha;

		this.queryProvider.expectOctokitRequest(
			['pullRequests', 'get'],
			[{owner: this.remote.owner, repo: this.remote.repositoryName, number: prNumber}],
			responses.pullRequest,
		);
		this.queryProvider.expectOctokitRequest(
			['issues', 'getEventsTimeline'],
			[{owner: this.remote.owner, repo: this.remote.repositoryName, number: prNumber}],
			responses.timelineEvents,
		);

		this._addPullRequestCommon(prNumber, headRef, responses);

		return this;
	}

	private _addPullRequestCommon<F>(prNumber: number, headRef: string | undefined, responses: ManagedPullRequest<F>) {
		this.queryProvider.expectOctokitRequest(
			['repos', 'get'],
			[{owner: this.remote.owner, repo: this.remote.repositoryName}],
			responses.repositoryREST,
		);
		if (headRef) {
			this.queryProvider.expectOctokitRequest(
				['repos', 'getCombinedStatusForRef'],
				[{owner: this.remote.owner, repo: this.remote.repositoryName, ref: headRef}],
				responses.combinedStatusREST,
			);
		}
		this.queryProvider.expectOctokitRequest(
			['pullRequests', 'getReviewRequests'],
			[{owner: this.remote.owner, repo: this.remote.repositoryName, number: prNumber}],
			responses.reviewRequestsREST,
		);
	}
}