import * as z from 'zod'
import { join } from 'std/path/mod.ts'
import { emptyDir } from 'std/fs/mod.ts'

const locales = [
	'id',
	'bs',
	'da',
	'de',
	'en',
	'es',
	'fr',
	'hr',
	'it',
	'sw',
	'lt',
	'hu',
	'nl',
	'nb',
	'pl',
	'pt-br',
	'pt',
	'ro',
	'sq',
	'sk',
	'fi',
	'sv',
	'vi',
	'tr',
	'cs',
	'el',
	'be',
	'mn',
	'ru',
	'sr',
	'uk',
	'bg',
	'mk',
	'hy',
	'he',
	'ar',
	'fa',
	'kmr',
	'ta',
	'th',
	'my',
	'zh-cn',
	'zh-tw',
	'ja',
	'ko',
] as const

type Locale = typeof locales[number]

const talkId = 1880

const rootDir = join('cached', 'ted-talks', String(talkId))
const txtDir = join(rootDir, 'txt')
const jsonDir = join(rootDir, 'json')
for (const dir of [rootDir, jsonDir, txtDir]) {
	await Deno.mkdir(dir, { recursive: true })
	await emptyDir(dir)
}

function toUrl(locale: Locale) {
	const url = new URL(`https://www.ted.com/talks/${talkId}/transcript.json`)
	url.searchParams.set('language', locale)
	return url
}

type Transcript = Awaited<ReturnType<typeof fetchTranscriptByLocale>>

async function fetchTranscriptByLocale(locale: Locale) {
	const res = await fetch(toUrl(locale))
	const data = await res.json()
	return z.object({
		paragraphs: z.object({
			cues: z.object({
				time: z.number(),
				text: z.string(),
			}).array(),
		}).array(),
	}).parse(data)
}

function getWordJoiner(locale: Locale) {
	return ['zh', 'ja'].includes(new Intl.Locale(locale).language) ? '' : ' '
}

function collapseWhiteSpace(str: string, joiner: string) {
	return str.replaceAll(/\s+/g, joiner)
}

function transcriptToPlainText(transcript: Transcript, locale: Locale) {
	const joiner = getWordJoiner(locale)
	return transcript.paragraphs.map((p) => p.cues.map((c) => collapseWhiteSpace(c.text, joiner)).join(joiner)).join(
		'\n\n',
	)
}

await Promise.all(locales.map(async (locale) => {
	const transcript = await fetchTranscriptByLocale(locale)

	await Deno.writeTextFile(join(jsonDir, `${locale}.json`), JSON.stringify(transcript, null, '\t'))
	await Deno.writeTextFile(join(txtDir, `${locale}.txt`), transcriptToPlainText(transcript, locale))
}))
