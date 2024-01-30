import { gql } from 'graphql-request'
import useSWRImmutable from 'swr'
import { makeGqlFetcher, RequestContext, ssrFetcher } from '../networkHelpers'

type ArticleQueryInput = {
  username?: string
  slug?: string
  includeFriendsHighlights?: boolean
}

type ArticleData = {
  article: NestedArticleData
}

type NestedArticleData = {
  article: ArticleAttributes
  errorCodes?: string[]
}

export type ArticleAttributes = {
  id: string
  originalHtml: string
}

const query = gql`
  query GetArticle($username: String!, $slug: String!) {
    article(username: $username, slug: $slug) {
      ... on ArticleSuccess {
        article {
          id
          originalHtml
        }
      }
      ... on ArticleError {
        errorCodes
      }
    }
  }
`

export function useGetArticleOriginalHtmlQuery({
  username,
  slug,
}: ArticleQueryInput): string | undefined {
  const variables = {
    username,
    slug,
  }

  const { data } = useSWRImmutable(
    slug ? [query, username, slug] : null,
    makeGqlFetcher(variables)
  )

  const resultData: ArticleData | undefined = data as ArticleData
  return resultData?.article.article.originalHtml
}
