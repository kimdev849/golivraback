async function revokeUserSessions(db, utilisateurId) {
  const { error } = await db
    .from('sessions')
    .update({ revoque: true })
    .eq('utilisateur_id', utilisateurId)
    .eq('revoque', false);
  if (error) throw error;
}

module.exports = {
  revokeUserSessions,
};
