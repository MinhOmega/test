#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Configuration
const COMMIT_TYPES = {
  feat: 'Features',
  fix: 'Bug Fixes',
  perf: 'Performance Improvements',
  refactor: 'Code Refactoring',
  test: 'Tests',
  docs: 'Documentation',
  style: 'Styles',
  chore: 'Chores',
};

// Get arguments
const [fromTag, toTag, outputFile] = process.argv.slice(2);

if (!fromTag || !toTag) {
  console.error(
    'Usage: node changelog-generator.js <fromTag> <toTag> [outputFile]',
  );
  process.exit(1);
}

// Get repository info
function getRepoInfo() {
  try {
    const remoteUrl = execSync('git config --get remote.origin.url')
      .toString()
      .trim();
    let repoPath;

    if (remoteUrl.startsWith('git@github.com:')) {
      repoPath = remoteUrl.replace('git@github.com:', '').replace('.git', '');
    } else if (remoteUrl.startsWith('https://github.com/')) {
      repoPath = remoteUrl
        .replace('https://github.com/', '')
        .replace('.git', '');
    } else {
      // Default fallback
      repoPath = 'organization/repo';
    }

    return {
      repoUrl: `https://github.com/${repoPath}`,
      repoPath,
    };
  } catch (error) {
    console.error('Error getting repository info:', error);
    return {
      repoUrl: 'https://github.com/organization/repo',
      repoPath: 'organization/repo',
    };
  }
}

// Get the current date in YYYY-MM-DD format
function getCurrentDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Parse commit message to extract type, scope, and subject
function parseCommitMessage(message) {
  // Match conventional commit format: type(scope): subject
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?: (.+)$/);

  if (!match) return null;

  const [, type, scope, subject] = match;

  // Only include commit types we care about
  if (!COMMIT_TYPES[type]) return null;

  return { type, scope, subject };
}

// Get commits between tags
function getCommitsBetweenTags(fromTag, toTag) {
  try {
    const gitLogCommand = `git log ${fromTag}..${toTag} --pretty=format:"%H|%s|%an|%ae"`;
    const output = execSync(gitLogCommand).toString().trim();

    if (!output) return [];

    return output
      .split('\n')
      .map((line) => {
        const [hash, subject, author, email] = line.split('|');

        // Skip GitHub Actions bot commits
        if (
          email === '41898282+github-actions[bot]@users.noreply.github.com' ||
          author === 'github-actions[bot]'
        ) {
          return null;
        }

        const parsedCommit = parseCommitMessage(subject);

        if (!parsedCommit) return null;

        return {
          hash,
          ...parsedCommit,
          author,
          email,
        };
      })
      .filter(Boolean); // Remove null entries
  } catch (error) {
    console.error('Error getting commits:', error);
    return [];
  }
}

// Get PR number from commit message if available
function getPRNumber(hash) {
  try {
    // Try to get the PR number from the commit message
    const command = `git show --format=%B -s ${hash}`;
    const commitMessage = execSync(command).toString().trim();

    // Look for PR references like (#123) or #123
    const prMatch =
      commitMessage.match(/\(#(\d+)\)/) || commitMessage.match(/#(\d+)/);
    return prMatch ? prMatch[1] : null;
  } catch (error) {
    return null;
  }
}

// Get contributor information
function getContributors(commits) {
  const contributors = {};

  commits.forEach((commit) => {
    const { author, email, hash } = commit;

    if (!contributors[email]) {
      // Get GitHub username if possible
      let username = author;
      try {
        const gitLogCommand = `git log -1 ${hash} --pretty=format:"%an|%ae|%cN|%cE"`;
        const output = execSync(gitLogCommand).toString().trim();
        const [, , committerName, committerEmail] = output.split('|');

        // Try to get GitHub username from commit
        if (committerEmail.includes('@users.noreply.github.com')) {
          username = committerEmail.split('@')[0];
        }
      } catch (error) {
        // Ignore errors, use author name as fallback
      }

      contributors[email] = {
        name: author,
        username,
        commits: [],
      };
    }

    contributors[email].commits.push(hash);
  });

  return Object.values(contributors);
}

// Generate markdown for the changelog
function generateChangelog(fromTag, toTag) {
  const { repoUrl, repoPath } = getRepoInfo();
  const currentDate = getCurrentDate();
  const commits = getCommitsBetweenTags(fromTag, toTag);

  // Group commits by type
  const commitsByType = {};
  commits.forEach((commit) => {
    if (!commitsByType[commit.type]) {
      commitsByType[commit.type] = [];
    }
    commitsByType[commit.type].push(commit);
  });

  // Start building the changelog
  let changelog = `# [${toTag.replace('v', '')}](${repoUrl}/compare/${fromTag}...${toTag}) (${currentDate})\n\n`;

  // Add sections for each commit type
  Object.keys(COMMIT_TYPES).forEach((type) => {
    if (commitsByType[type] && commitsByType[type].length > 0) {
      changelog += `\n### ${COMMIT_TYPES[type]}\n\n`;

      commitsByType[type].forEach((commit) => {
        const prNumber = getPRNumber(commit.hash);
        const scopeText = commit.scope ? `**${commit.scope}:** ` : '';
        const prLink = prNumber
          ? `([#${prNumber}](${repoUrl}/issues/${prNumber})) `
          : '';

        changelog += `* ${scopeText}${commit.subject} ${prLink}([${commit.hash.substring(0, 7)}](${repoUrl}/commit/${commit.hash}))\n`;
      });
    }
  });

  // Add contributors section
  const contributors = getContributors(commits);
  if (contributors.length > 0) {
    changelog += `\n### Contributors to this release\n\n`;

    contributors.forEach((contributor) => {
      const commitCount = contributor.commits.length;
      changelog += `- <img src="https://avatars.githubusercontent.com/${contributor.username}?v=4&s=18" alt="avatar" width="18"/> [${contributor.name}](https://github.com/${contributor.username}) +${commitCount} commit${commitCount > 1 ? 's' : ''}\n`;
    });
  }

  return changelog;
}

// Main execution
const changelog = generateChangelog(fromTag, toTag);

if (outputFile) {
  // Check if file exists and read its content
  let existingContent = '';
  try {
    if (fs.existsSync(outputFile)) {
      existingContent = fs.readFileSync(outputFile, 'utf8');
    }
  } catch (error) {
    console.error(`Error reading existing changelog: ${error.message}`);
  }

  // If this is the first entry, just write the new changelog
  if (!existingContent) {
    fs.writeFileSync(outputFile, changelog);
  } else {
    // Otherwise, prepend the new changelog to the existing content
    // Find the first heading (# [...]) in the existing content
    const firstHeadingMatch = existingContent.match(/^# \[.*?\]/m);

    if (firstHeadingMatch) {
      const index = existingContent.indexOf(firstHeadingMatch[0]);
      // Insert the new changelog before the first existing entry
      const updatedContent = `${existingContent.substring(0, index)}${changelog}\n\n${existingContent.substring(index)}`;

      fs.writeFileSync(outputFile, updatedContent);
    } else {
      // If no existing heading found, just append
      fs.writeFileSync(outputFile, `${changelog}\n\n${existingContent}`);
    }
  }

  console.log(`Changelog written to ${outputFile}`);
} else {
  console.log(changelog);
}
