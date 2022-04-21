export const DeploymentParams = {
  
  /*
  * CONTRACT DEPLOYMENT VARIABLES
  */

  // chain constants
  airswapAddress: '0x62069Ff3b5127742B0D86b5fF5C6c21cF5XXXXXX',
  gammaControllerAddress: '0x9e3b94819aaF6de606C4Aa844E3215725bXXXXXX',
  gammaWhitelistAddress: '0xe9963AFfc9a53e293c9bB547c52902071eXXXXXX',

  // vault contants
  vaultType: 0, // type 0 vault
  minProfits: 4, // 0.04%

  // strategy constants 
  underlyingAddress: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
  vaultStrategyName: 'SampleBusiness ETH Covered Call Strategy', //change the name based on strategy deployed i.e BusinessName + Token + Covered Call Stategy 
  vaultStrategyShortName: 'sbETHCoveredCall',  //change the short name based on strategy deployed i.e where sb is business abbreviation

  // owner constants
  newOwnerAddress: '0x364ae680071b81BE368A5AF20A48d154EFXXXXXX', // multisig or ...


  /*
  * CONTRACT VERIFICATION VARIABLES
  */
  opynPerpVaultAddress: "0x1F89774f01A2786bccCFbA9AF92E53b0B4XXXXXX"



};
 