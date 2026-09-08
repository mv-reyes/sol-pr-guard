

































impl PositionCalculations for PositionModel {
    fn status_with_options(
        &self,
        prices: &Prices<u128>,
        options: CalculatePositionStatusOptions,
    ) -> crate::Result<PositionStatus> {
        // collateral value
        let collateral_value = self.collateral_value(prices)?;

        // pnl
        let position_size_in_tokens = self.size_in_tokens();
        let position_size_in_usd = self.size_in_usd();
        let _position_size_in_usd_real = position_size_in_tokens
            .checked_mul(prices.index_token_price.max)
            .ok_or(gmsol_model::Error::Computation(
                "calculating position size in usd real",
            ))?;
        let (pending_pnl_value, _uncapped_pnl_value, _size_delta_in_tokens) =
            self.pnl_value(prices, position_size_in_usd)?;
        let entry_price = position_size_in_usd
            .checked_div(*position_size_in_tokens)
            .ok_or(gmsol_model::Error::Computation("calculating entry price"))?;

        // borrowing fee value
        let pending_borrowing_fee_value = self.pending_borrowing_fee_value()?;

        // funding fee value
        let pending_funding_fee = self.pending_funding_fees()?;
        let pending_funding_fee_value = if self.is_collateral_token_long() {
            pending_funding_fee
                .amount()
                .checked_mul(prices.long_token_price.min)
                .ok_or(gmsol_model::Error::Computation(
                    "calculating pending funding fee value",
                ))?
        } else {
            pending_funding_fee
                .amount()
                .checked_mul(prices.short_token_price.min)
                .ok_or(gmsol_model::Error::Computation(
                    "calculating pending funding fee value",
                ))?
        };
        let pending_claimable_funding_fee_value_in_long_token = pending_funding_fee
            .claimable_long_token_amount()
            .checked_mul(prices.long_token_price.min)
            .ok_or(gmsol_model::Error::Computation(
                "calculating pending claimable funding fee value in long token",
            ))?;
        let pending_claimable_funding_fee_value_in_short_token = pending_funding_fee
            .claimable_short_token_amount()
            .checked_mul(prices.short_token_price.min)
            .ok_or(gmsol_model::Error::Computation(
                "calculating pending claimable funding fee value in short token",
            ))?;

        // close order fee value
        let collateral_token_price = if self.is_collateral_token_long() {
            prices.long_token_price
        } else {
            prices.short_token_price
        };

        // net value = collateral value +  pending pnl - pending borrowing fee value - nagetive pending funding fee value - close order fee value let mut price_impact_value = self.position_price_impact(&size_delta_usd)?;
        let size_delta_usd = position_size_in_usd.to_opposite_signed()?;
        let price_impact =
            self.position_price_impact(&size_delta_usd, options.include_virtual_inventory_impact)?;

        let mut price_impact_value = price_impact.value;
        if price_impact_value.is_negative() {
            self.market().cap_negative_position_price_impact(
                &size_delta_usd,
                true,
                &mut price_impact_value,
            )?;
        } else {
            price_impact_value = Zero::zero();
        }

        let total_position_fees = self.position_fees(
            &collateral_token_price,
            position_size_in_usd,
            price_impact.balance_change,
            // Should not account for liquidation fees to determine if position should be liquidated.
            false,
        )?;

        let close_order_fee_value = *total_position_fees.order_fees().fee_value();

        let net_value = collateral_value
            .to_signed()?
            .checked_add(pending_pnl_value)
            .ok_or(gmsol_model::Error::Computation("calculating net value"))?
            .checked_sub(pending_borrowing_fee_value.to_signed()?)
            .ok_or(gmsol_model::Error::Computation("calculating net value"))?
            .checked_sub(pending_funding_fee_value.to_signed()?)
            .ok_or(gmsol_model::Error::Computation("calculating net value"))?
            .checked_sub(close_order_fee_value.to_signed()?)
            .ok_or(gmsol_model::Error::Computation("calculating net value"))?
            .max(Zero::zero());

        // leverage
        let leverage = if !net_value.is_positive() {
            None
        } else {
            Some(
                gmsol_model::utils::div_to_factor::<_, { constants::MARKET_DECIMALS }>(
                    position_size_in_usd,
                    &net_value.unsigned_abs(),
                    true,
                )
                .ok_or(gmsol_model::Error::Computation("calculating leverage"))?,
            )
        };

        // liquidation price
        //
        // The threshold must come from `min_collateral_factor_for_liquidation`, which is what
        // `check_liquidatable(.., for_liquidation = true)` compares against on the liquidation
        // path (`crates/model/src/position.rs`). It falls back to `min_collateral_factor` when
        // the market leaves it unset, and `position_params()` already resolves the
        // market-closed variant, so reading it here covers both.
        let params = self.market().position_params()?;
        let min_collateral_factor = params.min_collateral_factor_for_liquidation();
        let min_collateral_value = params.min_collateral_value();
        let liquidation_collateral_usd = gmsol_model::utils::apply_factor::<
            _,
            { constants::MARKET_DECIMALS },
        >(position_size_in_usd, min_collateral_factor)
        .max(Some(*min_collateral_value))
        .ok_or(gmsol_model::Error::Computation(
            "calculating liquidation collateral usd",
        ))?;

        // When the collateral token *is* the index token, two of the terms below are functions of
        // the very price being solved for, so they cannot be held at spot:
        //
        //   collateral_value        = collateral_amount        * collateral_token_price
        //   pending_funding_fee     = pending_funding_amount   * collateral_token_price
        //
        // Everything else is price-independent: the borrowing fee is `apply_factor(size_in_usd, ..)`
        // and the close order fee is `apply_factor(size_delta_usd, ..)`, both plain USD, and the
        // price impact is computed off pool balances. So the boundary stays linear in `P` and the
        // correction is entirely in the denominator:
        //
        //   long:  P = (liq + size_in_usd - K) / (size_in_tokens + collateral_amount - funding)
        //   short: P = (K + size_in_usd - liq) / (size_in_tokens - collateral_amount + funding)
        //
        // where K is what remains of `remaining_collateral_usd` once the two price-dependent terms
        // are taken back out. With a different collateral token the extra terms are zero and this
        // reduces to the original formula.
        //
        // Correlated-but-not-identical tokens are deliberately left uncorrected: that error decays
        // to zero as the position approaches liquidation and the UI recomputes continuously.
        let collateral_tracks_index =
            self.position().collateral_token == self.market_model().meta.index_token_mint;
        // The two amounts are added before either is subtracted, so an intermediate never
        // underflows. A short whose collateral exceeds `size_in_tokens + funding` has no
        // liquidation price on the way up at all, and the `checked_sub` returning `None` is the
        // right answer there rather than a number.
        let denominator = if collateral_tracks_index {
            let collateral_amount = *self.collateral_amount();
            let funding_amount = *pending_funding_fee.amount();
            if self.is_long() {
                position_size_in_tokens
                    .checked_add(collateral_amount)
                    .and_then(|d| d.checked_sub(funding_amount))
            } else {
                position_size_in_tokens
                    .checked_add(funding_amount)
                    .and_then(|d| d.checked_sub(collateral_amount))
            }
        } else {
            Some(*position_size_in_tokens)
        };

        let liquidation_price = if position_size_in_tokens.is_zero() {
            None
        } else {
            collateral_value
                .checked_add_signed(price_impact_value)
                .and_then(|a| a.checked_sub(pending_borrowing_fee_value))
                .and_then(|a| a.checked_sub(pending_funding_fee_value))
                .and_then(|a| a.checked_sub(close_order_fee_value))
                .and_then(|remaining_collateral_usd| {
                    // K: the price-independent part of the remaining collateral.
                    // fixed is always <= 0 (impact - borrowing_fee - close_order_fee):
                    // remaining_collateral_usd already nets out collateral_value, so the
                    // old `remaining + funding - collateral_value` underflowed to None.
                    // Compute the complement (>= 0) from the full-value side instead.
                    let fixed_complement = if collateral_tracks_index {
                        collateral_value
                            .checked_sub(pending_funding_fee_value)?
                            .checked_sub(remaining_collateral_usd)?
                    } else {
                        collateral_value.checked_sub(remaining_collateral_usd)?
                    };
                    let denominator = denominator?;
                    if denominator.is_zero() {
                        return None;
                    }
                    if self.is_long() {
                        liquidation_collateral_usd
                            .checked_add(*position_size_in_usd)?
                            .checked_add(fixed_complement)?
                            .checked_div(denominator)
                    } else {
                        (*position_size_in_usd)
                            .checked_sub(liquidation_collateral_usd)?
                            .checked_sub(fixed_complement)?
                            .checked_div(denominator)
                    }
                })
        };

        Ok(PositionStatus {
            entry_price,
            collateral_value,
            pending_pnl: pending_pnl_value,
            pending_borrowing_fee_value,
            pending_funding_fee_value,
            pending_claimable_funding_fee_value_in_long_token,
            pending_claimable_funding_fee_value_in_short_token,
            close_order_fee_value,
            net_value,
            leverage,
            liquidation_price,
        })
    }
}
