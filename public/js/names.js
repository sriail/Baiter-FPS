window.generateName = function() {
  const adj = [
    'Swift','Silent','Iron','Shadow','Storm','Frost','Blaze','Void','Steel','Ghost',
    'Rapid','Dark','Hyper','Night','Flash','Crimson','Neon','Toxic','Savage','Stealth',
    'Rogue','Lone','Astral','Burning','Frozen','Hollow','Fallen','Rising','Brutal','Cold',
    'Phantom','Silent','Deadly','Sly','Fierce','Bold','Sharp','Grim','Wild','Dire',
    'Neon','Solar','Lunar','Obsidian','Cobalt','Scarlet','Amber','Jade','Azure','Onyx',
    'Rustic','Cyber','Turbo','Hyper','Mega','Ultra','Alpha','Delta','Sigma','Omega'
  ];
  const noun = [
    'Falcon','Viper','Wolf','Eagle','Tiger','Hawk','Fox','Bear','Cobra','Shark',
    'Raven','Lion','Panther','Lynx','Drake','Scorpion','Hydra','Phoenix','Kraken','Wraith',
    'Specter','Jackal','Dagger','Bullet','Arrow','Blade','Fang','Claw','Talon','Reaper',
    'Striker','Hunter','Ranger','Sniper','Ghost','Raider','Bandit','Outlaw','Maverick','Drifter',
    'Sentinel','Guardian','Warden','Marshal','Titan','Colossus','Goliath','Leviathan','Behemoth','Nemesis',
    'Cipher','Vector','Matrix','Nexus','Vertex','Axiom','Prism','Photon','Quasar','Pulsar'
  ];
  return adj[Math.floor(Math.random() * adj.length)] + noun[Math.floor(Math.random() * noun.length)];
};
