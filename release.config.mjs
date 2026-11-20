export default {
  branches: ['release', { name: 'main', prerelease: 'main' }],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/npm',
      { npmPublish: process.env.GITHUB_REF === 'refs/heads/release' },
    ],
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
        failTitle: false,
        releasedLabels: false,
        addReleases: false,
      },
    ],
  ],
};
