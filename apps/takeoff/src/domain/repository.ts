export interface RegisteredRepository {
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryIndexItem {
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
}

export interface RepositoryIndex {
  items: RepositoryIndexItem[];
  updatedAt: string;
}
