import { logger } from '../utils/logger'
import { libraryItemRepository } from '../repository/library_item'
import { htmlToMarkdown, parsePreparedContent } from '../utils/parser'
import { LibraryItem } from '../entity/library_item'
import {
  createOrUpdateLibraryItem,
  searchLibraryItems,
} from '../services/library_item'
import { OpenAI } from '@langchain/openai'
import { PromptTemplate } from '@langchain/core/prompts'
import { v4 as uuid } from 'uuid'

import { env } from '../env'
import showdown from 'showdown'
import { parsedContentToLibraryItem, savePage } from '../services/save_page'
import { generateSlug } from '../utils/helpers'
import { PageType } from '../generated/graphql'
import * as stream from 'stream'

import { Storage } from '@google-cloud/storage'
import { readStringFromStorage } from '../utils/uploads'

export interface BuildDigestJobData {
  userId: string
}

export const BUILD_DIGEST_JOB_NAME = 'build-digest-job'

interface Selector {
  query: string
  count: number
  reason: string
}

interface DigestDefinition {
  name: string
  preferenceSelectors: Selector[]
  candidateSelectors: Selector[]
  fastMatchAttributes: string[]
  selectionPrompt: string
  assemblePrompt: string
  introductionCopy: string[]
}

interface SelectionResultItem {
  id: string
  title: string
  topic: string
  reason: string
}

interface SelectedLibraryItem {
  id: string
  title: string
  topic: string
  url: string
}

const fetchDigestDefinition = async (): Promise<
  DigestDefinition | undefined
> => {
  const bucketName = env.fileUpload.gcsUploadBucket

  try {
    const str = await readStringFromStorage(
      bucketName,
      `digest-builders/simple-001.json`
    )
    return JSON.parse(str) as DigestDefinition
  } catch (err) {
    logger.info(`unable to digest definition`, { error: err })
  }

  return undefined
}

function removeDuplicateTitles(items: LibraryItem[]): LibraryItem[] {
  const uniqueTitles: Set<string> = new Set()
  const uniqueItems: LibraryItem[] = []

  for (const item of items) {
    if (!uniqueTitles.has(item.title)) {
      uniqueTitles.add(item.title)
      uniqueItems.push(item)
    }
  }

  return uniqueItems
}

const createPreferencesList = async (
  digestDefinition: DigestDefinition,
  userId: string
): Promise<LibraryItem[]> => {
  const result: LibraryItem[] = []
  for (const selector of digestDefinition.preferenceSelectors) {
    const recentPreferences = await searchLibraryItems(
      {
        from: 0,
        size: selector.count,
        includePending: false,
        includeDeleted: false,
        includeContent: false,
        useFolders: false,
        query: selector.query,
      },
      userId
    )
    result.push(...recentPreferences.libraryItems)
  }
  return result
}

const createCandidatesList = async (
  digestDefinition: DigestDefinition,
  userId: string
): Promise<LibraryItem[]> => {
  const result: LibraryItem[] = []
  for (const selector of digestDefinition.candidateSelectors) {
    const candidates = await searchLibraryItems(
      {
        from: 0,
        size: selector.count,
        includePending: false,
        includeDeleted: false,
        includeContent: false,
        useFolders: false,
        query: selector.query,
      },
      userId
    )
    result.push(...candidates.libraryItems)
  }
  return removeDuplicateTitles(result)
}

const isSelectedLibraryItem = (
  item: SelectedLibraryItem | undefined
): item is SelectedLibraryItem => {
  return !!item
}

const getSelection = async (
  llm: OpenAI,
  digestDefinition: DigestDefinition,
  candidates: LibraryItem[],
  recentPreferences: LibraryItem[]
): Promise<SelectedLibraryItem[]> => {
  const selectionTemplate = PromptTemplate.fromTemplate(
    digestDefinition.selectionPrompt
  )
  const selectionChain = selectionTemplate.pipe(llm)
  const selectionResult = await selectionChain.invoke(
    {
      candidates: JSON.stringify(
        candidates.map((item: LibraryItem) => {
          return { id: item.id, title: item.title }
        })
      ),
      preferences: JSON.stringify(
        recentPreferences.map((item: LibraryItem) => {
          return { id: item.id, title: item.title }
        })
      ),
    },
    {}
  )

  console.log('[digest]: selectionResult: ', selectionResult)

  const selection = JSON.parse(selectionResult) as SelectionResultItem[]
  console.log('[digest]: selection: ', selection)
  console.log(
    '[digest]:  candidates: ',
    candidates.map((item) => item.id)
  )

  return selection
    .map((item) => {
      const libraryItem = candidates.find((candidate) => {
        return candidate.id == item.id
      })
      if (!libraryItem) {
        console.log('[digest]:  missing library item: ', item)
        return undefined
      }
      return {
        id: libraryItem.id,
        title: libraryItem.title,
        topic: item.topic,
        url: `${env.client.url}/me/${libraryItem.slug}`,
      }
    })
    .filter(isSelectedLibraryItem)
}

const createDigestArticleContent = async (
  llm: OpenAI,
  digestDefinition: DigestDefinition,
  candidates: LibraryItem[],
  selection: SelectedLibraryItem[]
): Promise<string | undefined> => {
  const introductionTemplate = PromptTemplate.fromTemplate(
    digestDefinition.assemblePrompt
  )
  const introductionChain = introductionTemplate.pipe(llm)
  const introductionResult = await introductionChain.invoke({
    selections: JSON.stringify(selection),
  })

  console.log(`[digest]: markdown:`, { introductionResult })

  const converter = new showdown.Converter({
    backslashEscapesHTMLTags: true,
  })

  const originalContent = converter.makeHtml(`
  Hello, this is your Omnivore daily digest. We want to make it easy for you to enjoy reading every day. To do 
  that we've picked some of the best items that were recently added to your library and created a digest. Enjoy!\n\n${introductionResult}`)
  return originalContent
}

export const buildDigest = async (jobData: BuildDigestJobData) => {
  try {
    console.log(
      '[digest]: ********************************* building daily digest ***********************************'
    )
    const digestDefinition = await fetchDigestDefinition()
    if (!digestDefinition) {
      logger.warn('[digest] no digest definition found')
      return
    }

    const candidates = await createCandidatesList(
      digestDefinition,
      jobData.userId
    )
    const recentPreferences = await createPreferencesList(
      digestDefinition,
      jobData.userId
    )

    console.log(
      '[digest]: preferences: ',
      recentPreferences.map((item: LibraryItem) => item.title)
    )
    console.log(
      '[digest]: candidates: ',
      candidates.map((item: LibraryItem) => `${item.id}: ${item.title}`)
    )

    const llm = new OpenAI({
      modelName: 'gpt-4', // gpt-4-1106-preview
      configuration: {
        apiKey: process.env.OPENAI_API_KEY,
      },
    })

    const selection = await getSelection(
      llm,
      digestDefinition,
      candidates,
      recentPreferences
    )
    const articleHTML = await createDigestArticleContent(
      llm,
      digestDefinition,
      candidates,
      selection
    )

    if (articleHTML) {
      const preparedDocument = {
        document: articleHTML,
        pageInfo: {},
      }

      const formattedDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(new Date())

      const title = `Your Omnivore Daily Digest for ${formattedDate}`
      const originalURL = `https://omnivore.app/me/digest?q=${uuid()}`
      const updatedContent = await parsePreparedContent(
        originalURL,
        preparedDocument,
        true
      )

      const slug = generateSlug(title)
      const libraryItemToSave = parsedContentToLibraryItem({
        croppedPathname: 'digest',
        itemType: PageType.Article,
        url: originalURL,
        slug: slug,
        userId: jobData.userId,
        title: title,
        parsedContent: updatedContent.parsedContent,
        originalHtml: articleHTML,
        preparedDocument: preparedDocument,
      })

      // create new item in database
      await createOrUpdateLibraryItem(libraryItemToSave, jobData.userId)
    }

    console.log('[digest]: INTRODUCTION RESULT: ', articleHTML)
  } catch (err) {
    console.log('error creating summary: ', err)
  }
}
