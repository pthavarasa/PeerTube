import * as express from 'express'
import { readFile } from 'fs-extra'
import { join } from 'path'
import validator from 'validator'
import { buildFileLocale, getDefaultLocale, is18nLocale, POSSIBLE_LOCALES } from '../../shared/core-utils/i18n/i18n'
import { HttpStatusCode } from '../../shared/core-utils/miscs/http-error-codes'
import { VideoPlaylistPrivacy, VideoPrivacy } from '../../shared/models/videos'
import { isTestInstance, sha256 } from '../helpers/core-utils'
import { escapeHTML } from '@shared/core-utils/renderer'
import { logger } from '../helpers/logger'
import { CONFIG } from '../initializers/config'
import {
  ACCEPT_HEADERS,
  AVATARS_SIZE,
  CUSTOM_HTML_TAG_COMMENTS,
  EMBED_SIZE,
  FILES_CONTENT_HASH,
  PLUGIN_GLOBAL_CSS_PATH,
  WEBSERVER
} from '../initializers/constants'
import { AccountModel } from '../models/account/account'
import { VideoModel } from '../models/video/video'
import { VideoChannelModel } from '../models/video/video-channel'
import { getActivityStreamDuration } from '../models/video/video-format-utils'
import { VideoPlaylistModel } from '../models/video/video-playlist'
import { MAccountActor, MChannelActor } from '../types/models'

type Tags = {
  ogType: string
  twitterCard: 'player' | 'summary' | 'summary_large_image'
  schemaType: string

  list?: {
    numberOfItems: number
  }

  siteName: string
  title: string
  url: string
  originUrl: string
  description: string

  embed?: {
    url: string
    createdAt: string
    duration?: string
    views?: number
  }

  image: {
    url: string
    width?: number
    height?: number
  }
}

class ClientHtml {

  private static htmlCache: { [path: string]: string } = {}

  static invalidCache () {
    logger.info('Cleaning HTML cache.')

    ClientHtml.htmlCache = {}
  }

  static async getDefaultHTMLPage (req: express.Request, res: express.Response, paramLang?: string) {
    const html = paramLang
      ? await ClientHtml.getIndexHTML(req, res, paramLang)
      : await ClientHtml.getIndexHTML(req, res)

    let customHtml = ClientHtml.addTitleTag(html)
    customHtml = ClientHtml.addDescriptionTag(customHtml)

    return customHtml
  }

  static async getWatchHTMLPage (videoId: string, req: express.Request, res: express.Response) {
    // Let Angular application handle errors
    if (!validator.isInt(videoId) && !validator.isUUID(videoId, 4)) {
      res.status(HttpStatusCode.NOT_FOUND_404)
      return ClientHtml.getIndexHTML(req, res)
    }

    const [ html, video ] = await Promise.all([
      ClientHtml.getIndexHTML(req, res),
      VideoModel.loadWithBlacklist(videoId)
    ])

    // Let Angular application handle errors
    if (!video || video.privacy === VideoPrivacy.PRIVATE || video.privacy === VideoPrivacy.INTERNAL || video.VideoBlacklist) {
      res.status(HttpStatusCode.NOT_FOUND_404)
      return html
    }

    let customHtml = ClientHtml.addTitleTag(html, escapeHTML(video.name))
    customHtml = ClientHtml.addDescriptionTag(customHtml, escapeHTML(video.description))

    const url = WEBSERVER.URL + video.getWatchStaticPath()
    const originUrl = video.url
    const title = escapeHTML(video.name)
    const siteName = escapeHTML(CONFIG.INSTANCE.NAME)
    const description = escapeHTML(video.description)

    const image = {
      url: WEBSERVER.URL + video.getPreviewStaticPath()
    }

    const embed = {
      url: WEBSERVER.URL + video.getEmbedStaticPath(),
      createdAt: video.createdAt.toISOString(),
      duration: getActivityStreamDuration(video.duration),
      views: video.views
    }

    const ogType = 'video'
    const twitterCard = CONFIG.SERVICES.TWITTER.WHITELISTED ? 'player' : 'summary_large_image'
    const schemaType = 'VideoObject'

    customHtml = ClientHtml.addTags(customHtml, {
      url,
      originUrl,
      siteName,
      title,
      description,
      image,
      embed,
      ogType,
      twitterCard,
      schemaType
    })

    return customHtml
  }

  static async getWatchPlaylistHTMLPage (videoPlaylistId: string, req: express.Request, res: express.Response) {
    // Let Angular application handle errors
    if (!validator.isInt(videoPlaylistId) && !validator.isUUID(videoPlaylistId, 4)) {
      res.status(HttpStatusCode.NOT_FOUND_404)
      return ClientHtml.getIndexHTML(req, res)
    }

    const [ html, videoPlaylist ] = await Promise.all([
      ClientHtml.getIndexHTML(req, res),
      VideoPlaylistModel.loadWithAccountAndChannel(videoPlaylistId, null)
    ])

    // Let Angular application handle errors
    if (!videoPlaylist || videoPlaylist.privacy === VideoPlaylistPrivacy.PRIVATE) {
      res.status(HttpStatusCode.NOT_FOUND_404)
      return html
    }

    let customHtml = ClientHtml.addTitleTag(html, escapeHTML(videoPlaylist.name))
    customHtml = ClientHtml.addDescriptionTag(customHtml, escapeHTML(videoPlaylist.description))

    const url = videoPlaylist.getWatchUrl()
    const originUrl = videoPlaylist.url
    const title = escapeHTML(videoPlaylist.name)
    const siteName = escapeHTML(CONFIG.INSTANCE.NAME)
    const description = escapeHTML(videoPlaylist.description)

    const image = {
      url: videoPlaylist.getThumbnailUrl()
    }

    const embed = {
      url: WEBSERVER.URL + videoPlaylist.getEmbedStaticPath(),
      createdAt: videoPlaylist.createdAt.toISOString()
    }

    const list = {
      numberOfItems: videoPlaylist.get('videosLength') as number
    }

    const ogType = 'video'
    const twitterCard = CONFIG.SERVICES.TWITTER.WHITELISTED ? 'player' : 'summary'
    const schemaType = 'ItemList'

    customHtml = ClientHtml.addTags(customHtml, {
      url,
      originUrl,
      siteName,
      embed,
      title,
      description,
      image,
      list,
      ogType,
      twitterCard,
      schemaType
    })

    return customHtml
  }

  static async getAccountHTMLPage (nameWithHost: string, req: express.Request, res: express.Response) {
    return this.getAccountOrChannelHTMLPage(() => AccountModel.loadByNameWithHost(nameWithHost), req, res)
  }

  static async getVideoChannelHTMLPage (nameWithHost: string, req: express.Request, res: express.Response) {
    return this.getAccountOrChannelHTMLPage(() => VideoChannelModel.loadByNameWithHostAndPopulateAccount(nameWithHost), req, res)
  }

  static async getEmbedHTML () {
    const path = ClientHtml.getEmbedPath()

    if (!isTestInstance() && ClientHtml.htmlCache[path]) return ClientHtml.htmlCache[path]

    const buffer = await readFile(path)

    let html = buffer.toString()
    html = await ClientHtml.addAsyncPluginCSS(html)
    html = ClientHtml.addCustomCSS(html)
    html = ClientHtml.addTitleTag(html)

    ClientHtml.htmlCache[path] = html

    return html
  }

  private static async getAccountOrChannelHTMLPage (
    loader: () => Promise<MAccountActor | MChannelActor>,
    req: express.Request,
    res: express.Response
  ) {
    const [ html, entity ] = await Promise.all([
      ClientHtml.getIndexHTML(req, res),
      loader()
    ])

    // Let Angular application handle errors
    if (!entity) {
      res.status(HttpStatusCode.NOT_FOUND_404)
      return ClientHtml.getIndexHTML(req, res)
    }

    let customHtml = ClientHtml.addTitleTag(html, escapeHTML(entity.getDisplayName()))
    customHtml = ClientHtml.addDescriptionTag(customHtml, escapeHTML(entity.description))

    const url = entity.getLocalUrl()
    const originUrl = entity.Actor.url
    const siteName = escapeHTML(CONFIG.INSTANCE.NAME)
    const title = escapeHTML(entity.getDisplayName())
    const description = escapeHTML(entity.description)

    const image = {
      url: entity.Actor.getAvatarUrl(),
      width: AVATARS_SIZE.width,
      height: AVATARS_SIZE.height
    }

    const ogType = 'website'
    const twitterCard = 'summary'
    const schemaType = 'ProfilePage'

    customHtml = ClientHtml.addTags(customHtml, {
      url,
      originUrl,
      title,
      siteName,
      description,
      image,
      ogType,
      twitterCard,
      schemaType
    })

    return customHtml
  }

  private static async getIndexHTML (req: express.Request, res: express.Response, paramLang?: string) {
    const path = ClientHtml.getIndexPath(req, res, paramLang)
    if (!isTestInstance() && ClientHtml.htmlCache[path]) return ClientHtml.htmlCache[path]

    const buffer = await readFile(path)

    let html = buffer.toString()

    if (paramLang) html = ClientHtml.addHtmlLang(html, paramLang)
    html = ClientHtml.addManifestContentHash(html)
    html = ClientHtml.addFaviconContentHash(html)
    html = ClientHtml.addLogoContentHash(html)
    html = ClientHtml.addCustomCSS(html)
    html = await ClientHtml.addAsyncPluginCSS(html)

    ClientHtml.htmlCache[path] = html

    return html
  }

  private static getIndexPath (req: express.Request, res: express.Response, paramLang: string) {
    let lang: string

    // Check param lang validity
    if (paramLang && is18nLocale(paramLang)) {
      lang = paramLang

      // Save locale in cookies
      res.cookie('clientLanguage', lang, {
        secure: WEBSERVER.SCHEME === 'https',
        sameSite: 'none',
        maxAge: 1000 * 3600 * 24 * 90 // 3 months
      })

    } else if (req.cookies.clientLanguage && is18nLocale(req.cookies.clientLanguage)) {
      lang = req.cookies.clientLanguage
    } else {
      lang = req.acceptsLanguages(POSSIBLE_LOCALES) || getDefaultLocale()
    }

    return join(__dirname, '../../../client/dist/' + buildFileLocale(lang) + '/index.html')
  }

  private static getEmbedPath () {
    return join(__dirname, '../../../client/dist/standalone/videos/embed.html')
  }

  private static addHtmlLang (htmlStringPage: string, paramLang: string) {
    return htmlStringPage.replace('<html>', `<html lang="${paramLang}">`)
  }

  private static addManifestContentHash (htmlStringPage: string) {
    return htmlStringPage.replace('[manifestContentHash]', FILES_CONTENT_HASH.MANIFEST)
  }

  private static addFaviconContentHash (htmlStringPage: string) {
    return htmlStringPage.replace('[faviconContentHash]', FILES_CONTENT_HASH.FAVICON)
  }

  private static addLogoContentHash (htmlStringPage: string) {
    return htmlStringPage.replace('[logoContentHash]', FILES_CONTENT_HASH.LOGO)
  }

  private static addTitleTag (htmlStringPage: string, title?: string) {
    let text = title || CONFIG.INSTANCE.NAME
    if (title) text += ` - ${CONFIG.INSTANCE.NAME}`

    const titleTag = `<title>${text}</title>`

    return htmlStringPage.replace(CUSTOM_HTML_TAG_COMMENTS.TITLE, titleTag)
  }

  private static addDescriptionTag (htmlStringPage: string, description?: string) {
    const content = description || CONFIG.INSTANCE.SHORT_DESCRIPTION
    const descriptionTag = `<meta name="description" content="${content}" />`

    return htmlStringPage.replace(CUSTOM_HTML_TAG_COMMENTS.DESCRIPTION, descriptionTag)
  }

  private static addCustomCSS (htmlStringPage: string) {
    const styleTag = `<style class="custom-css-style">${CONFIG.INSTANCE.CUSTOMIZATIONS.CSS}</style>`

    return htmlStringPage.replace(CUSTOM_HTML_TAG_COMMENTS.CUSTOM_CSS, styleTag)
  }

  private static async addAsyncPluginCSS (htmlStringPage: string) {
    const globalCSSContent = await readFile(PLUGIN_GLOBAL_CSS_PATH)
    if (globalCSSContent.byteLength === 0) return htmlStringPage

    const fileHash = sha256(globalCSSContent)
    const linkTag = `<link rel="stylesheet" href="/plugins/global.css?hash=${fileHash}" />`

    return htmlStringPage.replace('</head>', linkTag + '</head>')
  }

  private static generateOpenGraphMetaTags (tags: Tags) {
    const metaTags = {
      'og:type': tags.ogType,
      'og:site_name': tags.siteName,
      'og:title': tags.title,
      'og:image': tags.image.url
    }

    if (tags.image.width && tags.image.height) {
      metaTags['og:image:width'] = tags.image.width
      metaTags['og:image:height'] = tags.image.height
    }

    metaTags['og:url'] = tags.url
    metaTags['og:description'] = tags.description

    if (tags.embed) {
      metaTags['og:video:url'] = tags.embed.url
      metaTags['og:video:secure_url'] = tags.embed.url
      metaTags['og:video:type'] = 'text/html'
      metaTags['og:video:width'] = EMBED_SIZE.width
      metaTags['og:video:height'] = EMBED_SIZE.height
    }

    return metaTags
  }

  private static generateStandardMetaTags (tags: Tags) {
    return {
      name: tags.title,
      description: tags.description,
      image: tags.image.url
    }
  }

  private static generateTwitterCardMetaTags (tags: Tags) {
    const metaTags = {
      'twitter:card': tags.twitterCard,
      'twitter:site': CONFIG.SERVICES.TWITTER.USERNAME,
      'twitter:title': tags.title,
      'twitter:description': tags.description,
      'twitter:image': tags.image.url
    }

    if (tags.image.width && tags.image.height) {
      metaTags['twitter:image:width'] = tags.image.width
      metaTags['twitter:image:height'] = tags.image.height
    }

    if (tags.twitterCard === 'player') {
      metaTags['twitter:player'] = tags.embed.url
      metaTags['twitter:player:width'] = EMBED_SIZE.width
      metaTags['twitter:player:height'] = EMBED_SIZE.height
    }

    return metaTags
  }

  private static generateSchemaTags (tags: Tags) {
    const schema = {
      '@context': 'http://schema.org',
      '@type': tags.schemaType,
      'name': tags.title,
      'description': tags.description,
      'image': tags.image.url,
      'url': tags.url
    }

    if (tags.list) {
      schema['numberOfItems'] = tags.list.numberOfItems
      schema['thumbnailUrl'] = tags.image.url
    }

    if (tags.embed) {
      schema['embedUrl'] = tags.embed.url
      schema['uploadDate'] = tags.embed.createdAt

      if (tags.embed.duration) schema['duration'] = tags.embed.duration
      if (tags.embed.views) schema['iterationCount'] = tags.embed.views

      schema['thumbnailUrl'] = tags.image.url
      schema['contentUrl'] = tags.url
    }

    return schema
  }

  private static addTags (htmlStringPage: string, tagsValues: Tags) {
    const openGraphMetaTags = this.generateOpenGraphMetaTags(tagsValues)
    const standardMetaTags = this.generateStandardMetaTags(tagsValues)
    const twitterCardMetaTags = this.generateTwitterCardMetaTags(tagsValues)
    const schemaTags = this.generateSchemaTags(tagsValues)

    const { url, title, embed, originUrl } = tagsValues

    const oembedLinkTags: { type: string, href: string, title: string }[] = []

    if (embed) {
      oembedLinkTags.push({
        type: 'application/json+oembed',
        href: WEBSERVER.URL + '/services/oembed?url=' + encodeURIComponent(url),
        title
      })
    }

    let tagsString = ''

    // Opengraph
    Object.keys(openGraphMetaTags).forEach(tagName => {
      const tagValue = openGraphMetaTags[tagName]

      tagsString += `<meta property="${tagName}" content="${tagValue}" />`
    })

    // Standard
    Object.keys(standardMetaTags).forEach(tagName => {
      const tagValue = standardMetaTags[tagName]

      tagsString += `<meta property="${tagName}" content="${tagValue}" />`
    })

    // Twitter card
    Object.keys(twitterCardMetaTags).forEach(tagName => {
      const tagValue = twitterCardMetaTags[tagName]

      tagsString += `<meta property="${tagName}" content="${tagValue}" />`
    })

    // OEmbed
    for (const oembedLinkTag of oembedLinkTags) {
      tagsString += `<link rel="alternate" type="${oembedLinkTag.type}" href="${oembedLinkTag.href}" title="${oembedLinkTag.title}" />`
    }

    // Schema.org
    if (schemaTags) {
      tagsString += `<script type="application/ld+json">${JSON.stringify(schemaTags)}</script>`
    }

    // SEO, use origin URL
    tagsString += `<link rel="canonical" href="${originUrl}" />`

    return htmlStringPage.replace(CUSTOM_HTML_TAG_COMMENTS.META_TAGS, tagsString)
  }
}

function sendHTML (html: string, res: express.Response) {
  res.set('Content-Type', 'text/html; charset=UTF-8')

  return res.send(html)
}

async function serveIndexHTML (req: express.Request, res: express.Response) {
  if (req.accepts(ACCEPT_HEADERS) === 'html' ||
      !req.headers.accept) {
    try {
      await generateHTMLPage(req, res, req.params.language)
      return
    } catch (err) {
      logger.error('Cannot generate HTML page.', err)
      return res.sendStatus(HttpStatusCode.INTERNAL_SERVER_ERROR_500)
    }
  }

  return res.sendStatus(HttpStatusCode.NOT_ACCEPTABLE_406)
}

// ---------------------------------------------------------------------------

export {
  ClientHtml,
  sendHTML,
  serveIndexHTML
}

async function generateHTMLPage (req: express.Request, res: express.Response, paramLang?: string) {
  const html = await ClientHtml.getDefaultHTMLPage(req, res, paramLang)

  return sendHTML(html, res)
}
