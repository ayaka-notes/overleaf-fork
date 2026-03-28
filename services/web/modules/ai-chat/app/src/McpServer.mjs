/**
 * MCP Server factory.
 *
 * Each transport session gets a fresh Server instance bound to a specific
 * authenticated user. Individual tool calls then select a projectId.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import logger from '@overleaf/logger'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import PrivilegeLevels from '../../../../app/src/Features/Authorization/PrivilegeLevels.mjs'
import Sources from '../../../../app/src/Features/Authorization/Sources.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectHelper from '../../../../app/src/Features/Project/ProjectHelper.mjs'

// ── helpers ────────────────────────────────────────────────────────────────

function normalizeProjectPath(p) {
  if (!p || typeof p !== 'string') return ''
  return p.startsWith('/') ? p : `/${p}`
}

async function listProjectEntities(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId)
  const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)
  return docs
    .concat(files)
    .sort((a, b) => (a.path > b.path ? 1 : a.path < b.path ? -1 : 0))
    .map(e => ({
      path: e.path,
      type: e.doc != null ? 'doc' : 'file',
    }))
}

async function resolveProjectPath(projectId, filePath) {
  const normalized = normalizeProjectPath(filePath)
  if (!normalized) throw new Error('path is required')

  const project = await ProjectGetter.promises.getProject(projectId)
  const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)

  const docEntry = docs.find(e => normalizeProjectPath(e.path) === normalized)
  if (docEntry) return { type: 'doc', path: normalized, entity: docEntry.doc }

  const fileEntry = files.find(e => normalizeProjectPath(e.path) === normalized)
  if (fileEntry) return { type: 'file', path: normalized, entity: fileEntry.file }

  throw new Error(`File not found in project: ${normalized}`)
}

function getProjectIdFromArgs(args) {
  const projectId = args?.projectId
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new Error('"projectId" is required')
  }
  return projectId.trim()
}

async function assertUserCanReadProject(userId, projectId) {
  const canRead = await AuthorizationManager.promises.canUserReadProject(
    userId,
    projectId,
    null
  )

  if (!canRead) {
    throw new Error(`Access denied for project: ${projectId}`)
  }
}

function formatProjectEntry(project, accessLevel, source, userId) {
  const archived = ProjectHelper.isArchived(project, userId)
  const trashed = ProjectHelper.isTrashed(project, userId) && !archived

  return {
    id: project._id.toString(),
    name: project.name,
    accessLevel,
    source,
    archived,
    trashed,
    lastUpdated: project.lastUpdated?.toISOString?.() ?? null,
    rootDocId: project.rootDoc_id?.toString() ?? null,
  }
}

async function listUserProjects(userId) {
  const allProjects = await ProjectGetter.promises.findAllUsersProjects(
    userId,
    'name lastUpdated archived trashed owner_ref lastUpdatedBy rootDoc_id'
  )

  const formattedProjects = []
  const seenProjectIds = new Set()

  const addProjects = (projects, accessLevel, source) => {
    for (const project of projects) {
      const projectId = project._id.toString()
      if (seenProjectIds.has(projectId)) continue
      formattedProjects.push(formatProjectEntry(project, accessLevel, source, userId))
      seenProjectIds.add(projectId)
    }
  }

  addProjects(allProjects.owned, PrivilegeLevels.OWNER, Sources.OWNER)
  addProjects(
    allProjects.readAndWrite,
    PrivilegeLevels.READ_AND_WRITE,
    Sources.INVITE
  )
  addProjects(allProjects.review, PrivilegeLevels.REVIEW, Sources.INVITE)
  addProjects(allProjects.readOnly, PrivilegeLevels.READ_ONLY, Sources.INVITE)
  addProjects(
    allProjects.tokenReadAndWrite,
    PrivilegeLevels.READ_AND_WRITE,
    Sources.TOKEN
  )
  addProjects(allProjects.tokenReadOnly, PrivilegeLevels.READ_ONLY, Sources.TOKEN)

  return formattedProjects.sort((a, b) => a.name.localeCompare(b.name))
}

async function readBlobAsUtf8(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ── tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_projects',
    description:
      'List all projects the authenticated user can access. Clients should prefer rendering the JSON result as a fully bordered ASCII grid table using characters like +, -, and | for all outer borders and cell separators, similar to Python tabulate-style plain-text tables. Use columns: name, project id, access level, archived, trashed, last updated. Avoid Markdown tables when an ASCII grid table is possible. If an ASCII grid table is not possible, fall back to another table layout.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_files',
    description:
      'List all files and documents in an Overleaf project. Returns a JSON array of {path, type} objects where type is "doc" or "file".',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Overleaf project id returned by list_projects',
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_project_info',
    description:
      'Return basic metadata about an Overleaf project (name, id, root doc).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Overleaf project id returned by list_projects',
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read the full UTF-8 content of a project file or document by its project-relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Overleaf project id returned by list_projects',
        },
        path: {
          type: 'string',
          description: 'Project-relative path, e.g. "main.tex" or "/sections/intro.tex"',
        },
      },
      required: ['projectId', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_lines',
    description:
      'Read a 1-based line range from a project document. More efficient than read_file when you only need part of a large file.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Overleaf project id returned by list_projects',
        },
        path: { type: 'string', description: 'Project-relative path' },
        from: { type: 'integer', description: 'First line (1-based, inclusive)' },
        to: { type: 'integer', description: 'Last line (1-based, inclusive)' },
      },
      required: ['projectId', 'path', 'from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_file',
    description: 'Search for a text string within a project document. Returns matching lines with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Overleaf project id returned by list_projects',
        },
        path: { type: 'string', description: 'Project-relative path' },
        query: { type: 'string', description: 'Text to search for (case-sensitive substring match)' },
      },
      required: ['projectId', 'path', 'query'],
      additionalProperties: false,
    },
  },
]

// ── tool handlers ───────────────────────────────────────────────────────────

async function handleListProjects(userId) {
  const projects = await listUserProjects(userId)
  return JSON.stringify(projects, null, 2)
}

async function handleListFiles(projectId) {
  const entities = await listProjectEntities(projectId)
  return JSON.stringify(entities, null, 2)
}

async function handleGetProjectInfo(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId)
  return JSON.stringify(
    {
      id: project._id.toString(),
      name: project.name,
      rootDocId: project.rootDoc_id?.toString() ?? null,
    },
    null,
    2
  )
}

async function handleReadFile(projectId, args) {
  const { path } = args
  const resolved = await resolveProjectPath(projectId, path)

  if (resolved.type === 'doc') {
    const { lines } = await DocumentUpdaterHandler.promises.getDocument(
      projectId,
      resolved.entity._id,
      -1
    )
    return lines.join('\n')
  }

  // Binary file stored in history / filestore
  const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
    projectId,
    resolved.entity.hash,
    'GET'
  )
  const content = await readBlobAsUtf8(stream)
  if (content.includes('\u0000')) {
    throw new Error(`"${resolved.path}" appears to be a binary file`)
  }
  return content
}

async function handleReadLines(projectId, args) {
  const { path, from, to } = args

  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error('"from" and "to" must be positive integers with from <= to')
  }

  const resolved = await resolveProjectPath(projectId, path)
  if (resolved.type !== 'doc') {
    throw new Error('read_lines only works on text documents, not binary files')
  }

  const { lines } = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    resolved.entity._id,
    -1
  )

  const startIndex = from - 1
  const endIndex = to

  if (endIndex > lines.length) {
    throw new Error(
      `Line range ${from}-${to} exceeds document length (${lines.length} lines)`
    )
  }

  const selected = lines.slice(startIndex, endIndex)
  return selected.map((line, i) => `L${from + i}: ${line}`).join('\n')
}

async function handleSearchFile(projectId, args) {
  const { path, query } = args
  if (!query) throw new Error('"query" is required')

  const resolved = await resolveProjectPath(projectId, path)
  if (resolved.type !== 'doc') {
    throw new Error('search_file only works on text documents')
  }

  const { lines } = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    resolved.entity._id,
    -1
  )

  const matches = lines
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text }) => text.includes(query))

  if (matches.length === 0) return `No matches found for "${query}"`

  return matches
    .slice(0, 100)
    .map(({ line, text }) => `L${line}: ${text}`)
    .join('\n')
}

// ── server factory ──────────────────────────────────────────────────────────

/**
 * Create a new MCP Server instance bound to a userId.
 * Call once per transport session.
 */
function createMcpServer({ userId }) {
  const server = new Server(
    { name: 'overleaf', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params

    logger.info({ userId, toolName: name }, 'ai-chat MCP tool call')

    let text
    try {
      const projectId = name === 'list_projects' ? null : getProjectIdFromArgs(args)
      if (projectId != null) {
        await assertUserCanReadProject(userId, projectId)
      }

      switch (name) {
        case 'list_projects':
          text = await handleListProjects(userId)
          break
        case 'list_files':
          text = await handleListFiles(projectId)
          break
        case 'get_project_info':
          text = await handleGetProjectInfo(projectId)
          break
        case 'read_file':
          text = await handleReadFile(projectId, args)
          break
        case 'read_lines':
          text = await handleReadLines(projectId, args)
          break
        case 'search_file':
          text = await handleSearchFile(projectId, args)
          break
        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          }
      }
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      logger.warn(
        {
          error,
          userId,
          toolName: name,
          projectId: args?.projectId ?? null,
        },
        'ai-chat MCP tool error'
      )
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      }
    }
  })

  return server
}

export { createMcpServer }
