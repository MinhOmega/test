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
  ci: 'CI/CD',
};

// Get arguments
const [fromTag, toTag, outputFile, mode = 'changelog'] = process.argv.slice(2);

if (!fromTag || !toTag) {
  console.error(
    'Usage: node changelog-generator.js <fromTag> <toTag> [outputFile] [mode]',
  );
  process.exit(1);
}

// Get repository info dynamically
function getRepoInfo() {
  try {
    const remoteUrl = execSync('git config --get remote.origin.url')
      .toString()
      .trim();
    let repoPath;
    let organization;
    let repoName;

    if (remoteUrl.startsWith('git@github.com:')) {
      repoPath = remoteUrl.replace('git@github.com:', '').replace('.git', '');
    } else if (remoteUrl.startsWith('https://github.com/')) {
      repoPath = remoteUrl
        .replace('https://github.com/', '')
        .replace('.git', '');
    } else {
      console.warn('Unable to parse GitHub repository URL from git remote');
      // Try to get from package.json if available
      try {
        const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        if (packageJson.repository?.url) {
          const url = packageJson.repository.url;
          if (url.includes('github.com')) {
            repoPath = url.replace(/.*github\.com[/:]/, '').replace('.git', '');
          }
        }
      } catch (error) {
        console.warn('Could not extract repository info from package.json');
      }

      if (!repoPath) {
        throw new Error('Could not determine repository information');
      }
    }

    // Extract organization and repo name from path
    const pathParts = repoPath.split('/');
    if (pathParts.length >= 2) {
      organization = pathParts[0];
      repoName = pathParts[1];
    } else {
      throw new Error('Invalid repository path format');
    }

    return {
      repoUrl: `https://github.com/${repoPath}`,
      repoPath,
      organization,
      repoName,
    };
  } catch (error) {
    console.error('Error getting repository info:', error.message);
    process.exit(1);
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

// Get GitHub username from author email or name
function getGitHubUsername(author, email, hash) {
  try {
    // If email contains github username pattern
    if (email.includes('@users.noreply.github.com')) {
      const match = email.match(/^(\d+\+)?(.+)@users\.noreply\.github\.com$/);
      if (match) {
        return match[2];
      }
    }

    // Try to get from git config or commit info
    try {
      const gitConfigCommand = `git log -1 ${hash} --pretty=format:"%an|%ae|%cN|%cE"`;
      const output = execSync(gitConfigCommand).toString().trim();
      const [, , committerName, committerEmail] = output.split('|');

      if (committerEmail.includes('@users.noreply.github.com')) {
        const match = committerEmail.match(
          /^(\d+\+)?(.+)@users\.noreply\.github\.com$/,
        );
        if (match) {
          return match[2];
        }
      }
    } catch (error) {
      // Ignore errors
    }

    // Try to extract username from email domain or author name
    // Remove common email domains and use the part before @
    const emailUsername = email.split('@')[0];

    // Clean up potential usernames by removing dots, numbers at start, etc.
    const cleanUsername = emailUsername
      .replace(/\./g, '')
      .replace(/^\d+/, '')
      .replace(/[^a-zA-Z0-9\-_]/g, '');

    if (cleanUsername.length > 2) {
      return cleanUsername;
    }

    // Fallback: clean up author name
    return author.replace(/\s+/g, '').replace(/[^a-zA-Z0-9\-_]/g, '');
  } catch (error) {
    return author.replace(/\s+/g, '').replace(/[^a-zA-Z0-9\-_]/g, '');
  }
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
          author === 'github-actions[bot]' ||
          email.includes('github-actions[bot]')
        ) {
          return null;
        }

        const parsedCommit = parseCommitMessage(subject);

        if (!parsedCommit) return null;

        const username = getGitHubUsername(author, email, hash);

        return {
          hash,
          ...parsedCommit,
          author,
          email,
          username,
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

    // Look for PR references like (#123) or Merge pull request #123
    const prMatch =
      commitMessage.match(/\(#(\d+)\)/) ||
      commitMessage.match(/Merge pull request #(\d+)/) ||
      commitMessage.match(/#(\d+)/);
    return prMatch ? prMatch[1] : null;
  } catch (error) {
    return null;
  }
}

// Get the appropriate previous tag for comparison
function getPreviousTag(currentTag) {
  try {
    // Determine the branch pattern based on current tag
    let pattern;
    if (currentTag.includes('-beta.')) {
      // For beta tags, find previous beta tag
      pattern = 'v*-beta.*';
    } else if (currentTag.includes('-rc.')) {
      // For rc tags, find previous rc tag
      pattern = 'v*-rc.*';
    } else {
      // For production tags, find previous production tag (no pre-release identifier)
      pattern = 'v*';
    }

    // Get all tags matching the pattern, sorted by version
    const gitTagCommand = `git tag -l "${pattern}" --sort=-version:refname`;
    const tags = execSync(gitTagCommand)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    // Find the index of current tag and get the previous one
    const currentIndex = tags.indexOf(currentTag);
    if (currentIndex > 0 && currentIndex < tags.length) {
      return tags[currentIndex + 1];
    }

    // If no previous tag found with same pattern, get the latest tag overall
    const allTagsCommand = `git tag --sort=-version:refname`;
    const allTags = execSync(allTagsCommand)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    const allCurrentIndex = allTags.indexOf(currentTag);
    if (allCurrentIndex > 0 && allCurrentIndex < allTags.length) {
      return allTags[allCurrentIndex + 1];
    }

    // Fallback to first commit
    return execSync('git rev-list --max-parents=0 HEAD').toString().trim();
  } catch (error) {
    console.error('Error getting previous tag:', error);
    return execSync('git rev-list --max-parents=0 HEAD').toString().trim();
  }
}

// Generate GitHub-style release notes
function generateGitHubReleaseNotes(fromTag, toTag) {
  const { repoUrl, repoPath } = getRepoInfo();
  const commits = getCommitsBetweenTags(fromTag, toTag);

  if (commits.length === 0) {
    return `## What's Changed\n\nNo changes in this release.\n\n**Full Changelog**: ${repoUrl}/compare/${fromTag}...${toTag}`;
  }

  let releaseNotes = `## What's Changed\n`;

  commits.forEach((commit) => {
    const prNumber = getPRNumber(commit.hash);
    const scopeText = commit.scope ? `**${commit.scope}:** ` : '';
    const prLink = prNumber ? ` in ${repoUrl}/pull/${prNumber}` : '';

    releaseNotes += `* ${commit.type}: ${scopeText}${commit.subject} by @${commit.username}${prLink}\n`;
  });

  releaseNotes += `\n**Full Changelog**: ${repoUrl}/compare/${fromTag}...${toTag}`;

  return releaseNotes;
}

// Generate traditional changelog format
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

  return changelog;
}

// Main execution
let content;

if (mode === 'release-notes') {
  content = generateGitHubReleaseNotes(fromTag, toTag);
} else {
  content = generateChangelog(fromTag, toTag);
}

if (outputFile) {
  if (mode === 'release-notes') {
    fs.writeFileSync(outputFile, content);
    console.log(`Release notes written to ${outputFile}`);
  } else {
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
      fs.writeFileSync(outputFile, content);
    } else {
      // Otherwise, prepend the new changelog to the existing content
      // Find the first heading (# [...]) in the existing content
      const firstHeadingMatch = existingContent.match(/^# \[.*?\]/m);

      if (firstHeadingMatch) {
        const index = existingContent.indexOf(firstHeadingMatch[0]);
        // Insert the new changelog before the first existing entry
        const updatedContent = `${existingContent.substring(0, index)}${content}\n\n${existingContent.substring(index)}`;

        fs.writeFileSync(outputFile, updatedContent);
      } else {
        // If no existing heading found, just append
        fs.writeFileSync(outputFile, `${content}\n\n${existingContent}`);
      }
    }

    console.log(`Changelog written to ${outputFile}`);
  }
} else {
  console.log(content);
}