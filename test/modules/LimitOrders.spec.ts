import { web3, artifacts } from '@nomiclabs/buidler'

import { balanceSnap, etherSnap } from '../helpers/balanceSnap'
import assertRevert from '../helpers/assertRevert'
import { sign, toAddress } from '../helpers/account'

const BN = web3.utils.BN


const PineCore = artifacts.require('PineCore')
const ERC20 = artifacts.require('FakeERC20')
const WETH9 = artifacts.require('WETH9')
const FakeUniswapFactory = artifacts.require('FakeUniswapFactory')
const UniswapV1Factory = artifacts.require('IUniswapFactory')
const UniswapV2Factory = artifacts.require('UniswapV2Factory')
const UniswapV2Router01 = artifacts.require('UniswapV2Router01')
const UniswapV2Pair = artifacts.require('UniswapV2Pair')
const UniswapExchange = artifacts.require('IUniswapExchange')
const LimitOrderModule = artifacts.require('LimitOrders')
const UniswapV2Handler = artifacts.require('UniswapV2Handler')
const UniswapV1Handler = artifacts.require('UniswapV1Handler')
const HackerHandler = artifacts.require('HackerHandler')
const HackerNOETHHandler = artifacts.require('HackerNOETHHandler')



describe("Limit Orders Module", () => {
  const ethAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

  const maxBn = new BN(2).pow(new BN(256)).sub(new BN(1))

  let owner
  let user
  let anotherUser
  let fromOwner

  const never = maxBn

  const creationParams = {
    ...fromOwner,
    gas: 6e6,
    gasPrice: 21e9
  }

  // Contracts
  let token1
  let token2
  let weth
  let pineCore
  let uniswapV1Factory
  let uniswapV2Factory
  let uniswapV2Router
  let uniswapToken1V1
  let uniswapToken2V1
  let uniswapToken1V2
  let uniswapToken2V2
  let limitOrderModule
  let uniswapV2Handler
  let uniswapV1Handler

  beforeEach(async () => {

    const accounts = await web3.eth.getAccounts()

    owner = accounts[1]
    user = accounts[2]
    anotherUser = accounts[3]
    fromOwner = { from: owner }

    // Create tokens
    weth = await WETH9.new(creationParams)
    token1 = await ERC20.new(creationParams)
    token2 = await ERC20.new(creationParams)

    // Deploy Uniswap V1
    uniswapV1Factory = await UniswapV1Factory.at(
      (await FakeUniswapFactory.new()).address
    )
    await uniswapV1Factory.createExchange(token1.address)
    await uniswapV1Factory.createExchange(token2.address)
    uniswapToken1V1 = await UniswapExchange.at(
      await uniswapV1Factory.getExchange(token1.address)
    )
    uniswapToken2V1 = await UniswapExchange.at(
      await uniswapV1Factory.getExchange(token2.address)
    )

    // Deploy Uniswap V2
    uniswapV2Factory = await UniswapV2Factory.new(owner, creationParams)
    uniswapV2Router = await UniswapV2Router01.new(uniswapV2Factory.address, weth.address, creationParams)
    await uniswapV2Factory.createPair(weth.address, token1.address)
    await uniswapV2Factory.createPair(weth.address, token2.address)

    // Deploy exchange
    pineCore = await PineCore.new(creationParams)

    // Limit Orders module
    limitOrderModule = await LimitOrderModule.new(creationParams)

    // Uniswap handler
    uniswapV2Handler = await UniswapV2Handler.new(uniswapV2Factory.address, weth.address, web3.utils.soliditySha3(UniswapV2Pair._json.bytecode), creationParams)
    uniswapV1Handler = await UniswapV1Handler.new(uniswapV1Factory.address, creationParams)


    await token1.setBalance(new BN(2000000000), owner)
    await token2.setBalance(new BN(2000000000), owner)

    // Add liquidity to Uniswap exchange 1
    await token1.approve(uniswapToken1V1.address, maxBn, { from: owner })
    await uniswapToken1V1.addLiquidity(0, new BN(1000000000), never, {
      from: owner,
      value: new BN(5000000000)
    })

    // Add liquidity to Uniswap exchange 2
    await token2.approve(uniswapToken2V1.address, maxBn, { from: owner })
    await uniswapToken2V1.addLiquidity(0, new BN(1000000000), never, {
      from: owner,
      value: new BN(5000000000)
    })

    // Add liquidity to pair v2
    await token1.approve(uniswapV2Router.address, maxBn, { from: owner })
    await token2.approve(uniswapV2Router.address, maxBn, { from: owner })

    await uniswapV2Router.addLiquidityETH(
      token1.address,
      new BN(1000000000),
      new BN(1000000000),
      new BN(5000000000),
      owner,
      never,
      {
        from: owner,
        value: new BN(5000000000)
      }
    )


    await uniswapV2Router.addLiquidityETH(
      token2.address,
      new BN(1000000000),
      new BN(1000000000),
      new BN(5000000000),
      owner,
      never,
      {
        from: owner,
        value: new BN(5000000000)
      }
    )

    uniswapToken1V2 = await uniswapV2Factory.getPair(weth.address, token1.address)
    uniswapToken2V2 = await uniswapV2Factory.getPair(weth.address, token2.address)

  })

  describe('Module', () => {
    it('should recover tokens if they were sent by mistake', async () => {
      const userTokenSnap = await balanceSnap(token1, user, 'user')

      await token1.setBalance(new BN(300), user)
      await userTokenSnap.requireIncrease(new BN(300))

      await token1.transfer(limitOrderModule.address, new BN(300), { from: user })
      await userTokenSnap.requireDecrease(new BN(300))

      // Depoy handler
      const hackerHandler = await HackerHandler.new()

      // Execute directly because the module has tokens
      await limitOrderModule.execute(
        ethAddress,
        0,
        user,
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [hackerHandler.address, anotherUser, new BN(0)]
        )
      )
      await userTokenSnap.requireIncrease(new BN(300))
    })

    it('reverts if minimum is not required', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Create order
      const encodedOrder = await pineCore.encodeEthOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // ETH Address
        user,                             // Owner of the order
        witness,                          // Witness public address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        secret                            // Witness secret
      )

      await pineCore.depositEth(
        encodedOrder,
        {
          value: new BN(10000),
          from: user
        }
      )

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)

      // Execute order
      await assertRevert(pineCore.executeOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // Sell ETH
        user,                             // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        signature,                        // signature of the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV2Handler.address, anotherUser, new BN(8500)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      ), 'LimitOrders#execute: ISSUFICIENT_BOUGHT_TOKENS')
    })

    it('reverts if handler can not receive ETH', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Create order
      const encodedOrder = await pineCore.encodeEthOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // ETH Address
        user,                             // Owner of the order
        witness,                          // Witness public address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        secret                            // Witness secret
      )

      await pineCore.depositEth(
        encodedOrder,
        {
          value: new BN(10000),
          from: user
        }
      )

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)
      // Depoy handler
      const hackerHandler = await HackerHandler.new()

      // Execute order
      await assertRevert(pineCore.executeOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // Sell ETH
        user,                             // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        signature,                        // signature of the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [hackerHandler.address, anotherUser, new BN(10)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      ), 'LimitOrders#execute: ISSUFICIENT_BOUGHT_TOKENS')
    })

    it('reverts if hacker can not receive ETH', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Create order
      const encodedOrder = await pineCore.encodeEthOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // ETH Address
        user,                             // Owner of the order
        witness,                          // Witness public address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        secret                            // Witness secret
      )

      await pineCore.depositEth(
        encodedOrder,
        {
          value: new BN(10000),
          from: user
        }
      )

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)
      // Depoy handler
      const hackerNOETHHandler = await HackerNOETHHandler.new()

      // Execute order
      await assertRevert(pineCore.executeOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // Sell ETH
        user,                             // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        signature,                        // signature of the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [hackerNOETHHandler.address, anotherUser, new BN(10)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      ), 'LimitOrders#_transferAmount: ETH_TRANSFER_FAILED')
    })
  })

  describe('It should trade on Uniswap v1', () => {
    it('should execute buy tokens with ETH', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Create order
      const encodedOrder = await pineCore.encodeEthOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // ETH Address
        user,                             // Owner of the order
        witness,                          // Witness public address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        secret                            // Witness secret
      )

      await pineCore.depositEth(
        encodedOrder,
        {
          value: new BN(10000),
          from: user
        }
      )

      // Take balance snapshots
      const exEtherSnap = await etherSnap(pineCore.address, 'Uniswap EX')
      const executerEtherSnap = await etherSnap(anotherUser, 'executer')
      const uniswapEtherSnap = await etherSnap(uniswapToken1V1.address, 'uniswap')
      const userTokenSnap = await balanceSnap(token1, user, 'user')
      const uniswapTokenSnap = await balanceSnap(
        token1,
        uniswapToken1V1.address,
        'uniswap'
      )

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)

      // Execute order
      const tx = await pineCore.executeOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // Sell ETH
        user,                             // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        signature,                        // signature of the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV1Handler.address, anotherUser, new BN(10)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      )

      const bought = tx.logs[0].args._bought


      // Validate balances
      await exEtherSnap.requireDecrease(new BN(10000))
      await executerEtherSnap.requireIncrease(new BN(10))
      await uniswapEtherSnap.requireIncrease(new BN(9990))
      await userTokenSnap.requireIncrease(bought)
      await uniswapTokenSnap.requireDecrease(bought)
    })

    it('should execute sell tokens for ETH', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Encode order transfer
      const orderTx = await pineCore.encodeTokenOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            ethAddress,               // Buy ETH
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        secret,                       // Witness secret
        new BN(10000)                 // Tokens to sell
      )

      const vaultAddress = await pineCore.vaultOfOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            ethAddress,               // Buy ETH
            new BN(50)               // Get at least 50 ETH Wei
          ]
        )
      )

      const vaultSnap = await balanceSnap(token1, vaultAddress, 'token vault')

      await token1.setBalance(new BN(10000), user)

      // Send tokens tx
      await web3.eth.sendTransaction({
        from: user,
        to: token1.address,
        data: orderTx,
        gasPrice: 0
      })

      await vaultSnap.requireIncrease(new BN(10000))

      // Take balance snapshots
      const exTokenSnap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const exEtherSnap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const executerEtherSnap = await etherSnap(anotherUser, 'executer')
      const uniswapTokenSnap = await balanceSnap(
        token1,
        uniswapToken1V1.address,
        'uniswap'
      )
      const uniswapEtherSnap = await etherSnap(uniswapToken1V1.address, 'uniswap')
      const userTokenSnap = await etherSnap(user, 'user')

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)

      // Execute order
      const tx = await pineCore.executeOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            ethAddress,               // Buy ETH
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        signature,                    // signature, sender signed using the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV1Handler.address, anotherUser, new BN(15)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      )

      const bought = tx.logs[0].args._bought

      // Validate balances
      await exEtherSnap.requireConstant()
      await exTokenSnap.requireConstant()
      await executerEtherSnap.requireIncrease(new BN(15))
      await uniswapTokenSnap.requireIncrease(new BN(10000))
      await uniswapEtherSnap.requireDecrease(bought.add(new BN(15)))
      await userTokenSnap.requireIncrease(bought)
    })

    it('Should execute tokens for tokens', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Encode order transfer
      const orderTx = await pineCore.encodeTokenOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token2.address,           // Buy TOKEN 2
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        secret,                       // Witness secret
        new BN(1000)                  // Tokens to sell
      )

      const vaultAddress = await pineCore.vaultOfOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token2.address,           // Buy TOKEN 2
            new BN(50)               // Get at least 50 ETH Wei
          ]
        )
      )

      const vaultSnap = await balanceSnap(token1, vaultAddress, 'token vault')

      const amount = new BN(1000)

      await token1.setBalance(amount, user)

      // Send tokens tx
      await web3.eth.sendTransaction({
        from: user,
        to: token1.address,
        data: orderTx,
        gasPrice: 0
      })

      await vaultSnap.requireIncrease(amount)

      // Take balance snapshots
      const exToken1Snap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const exToken2Snap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const exEtherSnap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const executerEtherSnap = await etherSnap(anotherUser, 'executer')
      const uniswap1TokenSnap = await balanceSnap(
        token1,
        uniswapToken1V1.address,
        'uniswap'
      )
      const uniswap2TokenSnap = await balanceSnap(
        token2,
        uniswapToken2V1.address,
        'uniswap'
      )
      const userToken2Snap = await balanceSnap(token2, user, 'user')

      const signature = sign(anotherUser, secret)

      // Execute order
      const tx = await pineCore.executeOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token2.address,           // Buy TOKEN 2
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        signature,                    // signature, sender signed using the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV1Handler.address, anotherUser, new BN(9)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      )

      const bought = tx.logs[0].args._bought

      // Validate balances
      await exEtherSnap.requireConstant()
      await exToken1Snap.requireConstant()
      await exToken2Snap.requireConstant()
      await vaultSnap.requireDecrease(amount)
      await executerEtherSnap.requireIncrease(new BN(9))
      await uniswap1TokenSnap.requireIncrease(amount)
      await uniswap2TokenSnap.requireDecrease(bought)
      await userToken2Snap.requireIncrease(bought)
    })
  })

  describe('It should trade on Uniswap v2', () => {
    it('should execute buy tokens with ETH', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Create order
      const encodedOrder = await pineCore.encodeEthOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // ETH Address
        user,                             // Owner of the order
        witness,                          // Witness public address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        secret                            // Witness secret
      )

      await pineCore.depositEth(
        encodedOrder,
        {
          value: new BN(10000),
          from: user
        }
      )

      // Take balance snapshots
      const exEtherSnap = await etherSnap(pineCore.address, 'Uniswap EX')
      const executerEtherSnap = await etherSnap(anotherUser, 'executer')
      const uniswapWethSnap = await balanceSnap(weth, uniswapToken1V2, 'uniswap')
      const userTokenSnap = await balanceSnap(token1, user, 'user')
      const uniswapTokenSnap = await balanceSnap(
        token1,
        uniswapToken1V2,
        'uniswap'
      )

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)

      // Execute order
      const tx = await pineCore.executeOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // Sell ETH
        user,                             // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300)                  // Get at least 300 Tokens
          ]
        ),
        signature,                        // signature of the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV2Handler.address, anotherUser, new BN(10)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      )

      const bought = tx.logs[0].args._bought

      // Validate balances
      await exEtherSnap.requireDecrease(new BN(10000))
      await executerEtherSnap.requireIncrease(new BN(10))
      await uniswapWethSnap.requireIncrease(new BN(9990))
      await userTokenSnap.requireIncrease(bought)
      await uniswapTokenSnap.requireDecrease(bought)
    })

    it('should execute sell tokens for ETH', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      // Encode order transfer
      const orderTx = await pineCore.encodeTokenOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            ethAddress,               // Buy ETH
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        secret,                       // Witness secret
        new BN(10000)                 // Tokens to sell
      )

      const vaultAddress = await pineCore.vaultOfOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            ethAddress,               // Buy ETH
            new BN(50)               // Get at least 50 ETH Wei
          ]
        )
      )

      const vaultSnap = await balanceSnap(token1, vaultAddress, 'token vault')

      await token1.setBalance(new BN(10000), user)

      // Send tokens tx
      await web3.eth.sendTransaction({
        from: user,
        to: token1.address,
        data: orderTx,
        gasPrice: 0
      })

      await vaultSnap.requireIncrease(new BN(10000))

      // Take balance snapshots
      const exTokenSnap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const exEtherSnap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const executerEtherSnap = await etherSnap(anotherUser, 'executer')
      const uniswapTokenSnap = await balanceSnap(
        token1,
        uniswapToken1V2,
        'uniswap'
      )
      const uniswapWethSnap = await balanceSnap(weth, uniswapToken1V2, 'uniswap')
      const userTokenSnap = await etherSnap(user, 'user')

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)

      // Execute order
      const tx = await pineCore.executeOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            ethAddress,               // Buy ETH
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        signature,                    // signature, sender signed using the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV2Handler.address, anotherUser, new BN(15)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      )

      const bought = tx.logs[0].args._bought

      // Validate balances
      await exEtherSnap.requireConstant()
      await exTokenSnap.requireConstant()
      await executerEtherSnap.requireIncrease(new BN(15))
      await uniswapTokenSnap.requireIncrease(new BN(10000))
      await uniswapWethSnap.requireDecrease(bought.add(new BN(15)))
      await userTokenSnap.requireIncrease(bought)
    })

    it('Should execute tokens for tokens', async () => {
      const secret = web3.utils.randomHex(32)
      const witness = toAddress(secret)

      const amount = new BN(1000)

      // Encode order transfer
      const orderTx = await pineCore.encodeTokenOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token2.address,           // Buy TOKEN 2
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        secret,                       // Witness secret
        amount                        // Tokens to sell
      )

      const vaultAddress = await pineCore.vaultOfOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        witness,                      // Witness address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token2.address,           // Buy TOKEN 2
            new BN(50)               // Get at least 50 ETH Wei
          ]
        )
      )

      const vaultSnap = await balanceSnap(token1, vaultAddress, 'token vault')

      await token1.setBalance(amount, user)

      // Send tokens tx
      await web3.eth.sendTransaction({
        from: user,
        to: token1.address,
        data: orderTx,
        gasPrice: 0
      })

      await vaultSnap.requireIncrease(amount)

      // Take balance snapshots
      const exToken1Snap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const exToken2Snap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const exEtherSnap = await balanceSnap(
        token1,
        pineCore.address,
        'Uniswap EX'
      )
      const executerEtherSnap = await etherSnap(anotherUser, 'executer')
      const uniswap1TokenSnap = await balanceSnap(
        token1,
        uniswapToken1V2,
        'uniswap'
      )
      const uniswap2TokenSnap = await balanceSnap(
        token2,
        uniswapToken2V2,
        'uniswap'
      )
      const userToken2Snap = await balanceSnap(token2, user, 'user')

      const signature = sign(anotherUser, secret)

      // Execute order
      const tx = await pineCore.executeOrder(
        limitOrderModule.address,     // Limit orders module
        token1.address,               // Sell token 1
        user,                         // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256'],
          [
            token2.address,           // Buy TOKEN 2
            new BN(50)               // Get at least 50 ETH Wei
          ]
        ),
        signature,                    // signature, sender signed using the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV2Handler.address, anotherUser, new BN(9)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      )

      const bought = tx.logs[0].args._bought

      // Validate balances
      await exEtherSnap.requireConstant()
      await exToken1Snap.requireConstant()
      await exToken2Snap.requireConstant()
      await vaultSnap.requireDecrease(amount)
      await executerEtherSnap.requireIncrease(new BN(9))
      await uniswap1TokenSnap.requireIncrease(amount)
      await uniswap2TokenSnap.requireDecrease(bought)
      await userToken2Snap.requireIncrease(bought)
    })
  })


  describe('It should work with easter egg', () => {
    it('should execute a trade', async () => {
      const randsecret = web3.utils.randomHex(13).replace('0x', '')
      const secret = `0x20756e697377617065782e696f2020d83ddc09${randsecret}`
      const witness = toAddress(secret)

      // Create order
      const encodedOrder = await pineCore.encodeEthOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // ETH Address
        user,                             // Owner of the order
        witness,                          // Witness public address
        web3.eth.abi.encodeParameters(
          ['address', 'uint256', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300),                  // Get at least 300 Tokens
            new BN(10)                    // Pay 10 WEI to sender
          ]
        ),
        secret                   // Witness secret
      )

      await pineCore.depositEth(
        encodedOrder,
        {
          value: new BN(10000),
          from: user
        }
      )

      // Take balance snapshots
      const exEtherSnap = await etherSnap(pineCore.address, 'Uniswap EX')
      const executerEtherSnap = await etherSnap(anotherUser, 'executer')
      const uniswapEtherSnap = await etherSnap(uniswapToken1V1.address, 'uniswap')
      const userTokenSnap = await balanceSnap(token1, user, 'user')
      const uniswapTokenSnap = await balanceSnap(
        token1,
        uniswapToken1V1.address,
        'uniswap'
      )

      // Sign signature using the secret
      const signature = sign(anotherUser, secret)

      // Execute order
      const tx = await pineCore.executeOrder(
        limitOrderModule.address,         // Limit orders module
        ethAddress,                       // Sell ETH
        user,                             // Owner of the order
        web3.eth.abi.encodeParameters(
          ['address', 'uint256', 'uint256'],
          [
            token1.address,               // Buy TOKEN 1
            new BN(300),                  // Get at least 300 Tokens
            new BN(10)                    // Pay 10 WEI to sender
          ]
        ),
        signature,                        // signature of the secret
        web3.eth.abi.encodeParameters(
          ['address', 'address', 'uint256'],
          [uniswapV1Handler.address, anotherUser, new BN(10)]
        ),
        {
          from: anotherUser,
          gasPrice: 0
        }
      )

      const bought = tx.logs[0].args._bought

      // Validate balances
      await exEtherSnap.requireDecrease(new BN(10000))
      await executerEtherSnap.requireIncrease(new BN(10))
      await uniswapEtherSnap.requireIncrease(new BN(9990))
      await userTokenSnap.requireIncrease(bought)
      await uniswapTokenSnap.requireDecrease(bought)
    })
  })
})