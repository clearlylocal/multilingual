import * as z from 'zod'
import { join } from 'std/path/mod.ts'
import { emptyDir } from 'std/fs/mod.ts'
import { retry } from 'std/async/retry.ts'
import { assert } from 'std/assert/mod.ts'

const wikiLocaleBrand = Symbol('WikiLocale')
type WikiLocaleBrand = typeof wikiLocaleBrand
type WikiLocale = string & z.BRAND<WikiLocaleBrand>

const baseLocale = 'en' as WikiLocale
function baseUrl(locale: WikiLocale) {
	return new URL(`https://${locale}.wikipedia.org/w/api.php`)
}

// mostly a selection from https://en.wikipedia.org/wiki/Wikipedia:Wikipedia_articles_written_in_the_greatest_number_of_languages
const titles = [
	'Lorem ipsum',
	'Gravity',
	'Earth',
	'Philosophy',
	'Music',
	'Albert Einstein',
	'Eye',
	'Alphabet',
	'Love',
	'Wikipedia',
	'Language',
]

function fetch(url: string | URL, init?: RequestInit) {
	return retry(async () => {
		const res = await globalThis.fetch(url, init)
		assert(res.ok, `Sever returned ${res.status}`)
		return res
	})
}

async function getLangLinks(title: string) {
	const url = baseUrl(baseLocale)
	for (
		const [k, v] of Object.entries({
			origin: '*',
			format: 'json',
			action: 'query',
			prop: 'langlinks',
			titles: title,
			lllimit: '500',
		})
	) {
		url.searchParams.set(k, v)
	}

	const res = await fetch(url)
	const data = await res.json()

	const d = z.object({
		query: z.object({
			pages: z.record(
				z.string().refine((x): x is `${number}` => !/\D/.test(x)),
				z.object({
					pageid: z.number(),
					ns: z.number(),
					title: z.string(),
					langlinks: z.object({
						lang: z.string().brand(wikiLocaleBrand),
						'*': z.string(),
					}).array(),
				}),
			),
		}),
	}).parse(data)

	return data as typeof d
}

type LangLink = Exclude<
	Awaited<ReturnType<typeof getLangLinks>>['query']['pages'][`${number}`],
	undefined
>['langlinks'][number]

async function getTextContent({ lang, '*': title }: LangLink) {
	const url = baseUrl(lang)
	for (
		const [k, v] of Object.entries({
			origin: '*',
			format: 'json',
			action: 'query',
			prop: 'extracts',
			explaintext: '',
			titles: title,
		})
	) {
		url.searchParams.set(k, v)
	}

	const res = await fetch(url)
	const data = await res.json()

	const d = z.object({
		query: z.object({
			pages: z.record(
				z.string().refine((x): x is `${number}` => !/\D/.test(x)),
				z.object({
					pageid: z.number(),
					ns: z.number(),
					title: z.string(),
					extract: z.string(),
				}),
			),
		}),
	}).parse(data)

	return data as typeof d
}

async function getHtmlContent({ lang, '*': title }: LangLink) {
	const url = new URL(`https://${lang}.wikipedia.org/w/api.php`)
	for (
		const [k, v] of Object.entries({
			origin: '*',
			format: 'json',
			action: 'parse',
			page: title,
			prop: 'text',
		})
	) {
		url.searchParams.set(k, v)
	}

	const res = await fetch(url)
	const data = await res.json()

	const d = z.object({
		parse: z.object({
			pageid: z.number(),
			title: z.string(),
			text: z.object({
				'*': z.string(),
			}),
		}),
	}).parse(data)

	return data as typeof d
}

const errors: unknown[] = []

async function all(values: Promise<void>[]) {
	const results = await Promise.allSettled(values)
	for (const x of results) {
		if (x.status === 'rejected') {
			errors.push(x.reason)
		}
	}
	return results
}

type LangLinksPages = Awaited<ReturnType<typeof getLangLinks>>['query']['pages']
const pages: LangLinksPages = {}

const rootDir = join('cached', 'wikipedia')

let nWritten = 0

await all(titles.map(async (title) => {
	const data = await getLangLinks(title)

	for (const [k, v] of Object.entries(data.query.pages)) {
		pages[k as `${number}`] = v!
	}

	const langLinks = [
		{ lang: baseLocale, '*': title },
		...Object.values(data.query.pages).at(0)!.langlinks,
	]

	const titleDir = join(rootDir, title)
	const jsonDir = join(titleDir, 'json')
	const txtDir = join(titleDir, 'txt')
	const htmlDir = join(titleDir, 'html')
	for (const dir of [titleDir, jsonDir, txtDir, htmlDir]) {
		await Deno.mkdir(dir, { recursive: true })
	}

	type Params = {
		text: Awaited<ReturnType<typeof getTextContent>>
		html: Awaited<ReturnType<typeof getHtmlContent>>
	}
	type FileConfig = Record<string, (params: Params) => string>

	await all(langLinks.map(async (x) => {
		const txtPath = join(txtDir, `${x.lang}.txt`)
		const htmlPath = join(htmlDir, `${x.lang}.html`)
		const jsonPath = join(jsonDir, `${x.lang}.json`)

		const toRun: { path: string; fn: (params: Params) => string }[] = []

		const fileConfig: FileConfig = {
			[txtPath]: ({ text }) => Object.values(text.query.pages).at(0)!.extract,
			[htmlPath]: ({ html }) => html.parse.text['*'],
			[jsonPath]: ({ text, html }) => JSON.stringify({ text, html }, null, '\t'),
		}

		for (const [path, fn] of Object.entries(fileConfig)) {
			try {
				await Deno.stat(path)
				console.log(`${++nWritten} (${path} already written)`)
			} catch {
				toRun.push({ path, fn })
			}
		}

		if (toRun.length) {
			const text = await getTextContent(x)
			const html = await getHtmlContent(x)

			await all(toRun.map(async ({ path, fn }) => {
				await Deno.writeTextFile(path, fn({ text, html }))
				console.log(`${++nWritten} (Wrote ${path})`)
			}))
		}
	}))
}))

await Deno.writeTextFile(join(rootDir, 'lang-links.json'), JSON.stringify({ pages }, null, '\t'))

if (errors.length) {
	console.error('⚠️ Finished with errors', { errors })
	Deno.exit(1)
} else {
	console.info('✅ Finished with no errors')
	Deno.exit(0)
}

// import { load } from 'cheerio'
// const html = await Deno.readTextFile('./cached/wikipedia/Gravity/html/es.html')
// const $ = load(html)
// await Deno.writeTextFile('__x.txt', $.text())
