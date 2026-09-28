// Immutable, local copy of eth55-audit-v1/ORIGINAL.json. No dynamic source imports.
export const SOURCE_SHA256 = '76185f11d2dc42979732e8f64544077d28cf52cafc60623da5c7323144694142';
export const SOURCE_PATH = 'Hajsomat-Silnik-GPU/wyniki/eth55-audit-v1/ORIGINAL.json';
export function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export const ORIGINAL = deepFreeze({
  "id": "state_graph-55",
  "role": "candidate",
  "spec": {
    "schema": 3,
    "id": "state_graph-55",
    "kind": "state_graph",
    "backend": "signed-v1",
    "every_h": 0.25,
    "params": {
      "asset": 1,
      "side": 1,
      "gross_cap": 1,
      "position_atr": "atr14",
      "initial": "watch",
      "exit": "exit",
      "states": {
        "watch": {
          "action": {
            "kind": "flat"
          },
          "next": [
            {
              "to": "enter",
              "label": "entry-atoms",
              "when": {
                "all": [
                  {
                    "left": {
                      "feature": "vol14",
                      "asset": 1
                    },
                    "op": "gt",
                    "right": 0.01
                  },
                  {
                    "left": {
                      "feature": "er48",
                      "asset": 1
                    },
                    "op": "gt",
                    "right": 0.45
                  },
                  {
                    "left": {
                      "feature": "rsi14",
                      "asset": 1
                    },
                    "op": "le",
                    "right": 65
                  }
                ]
              }
            }
          ]
        },
        "enter": {
          "action": {
            "kind": "allocate",
            "weight": 1
          },
          "next": [
            {
              "to": "exit",
              "label": "stop",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "le",
                "right": -2.5
              }
            },
            {
              "to": "exit",
              "label": "trailing",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "peak_move_atr"
                    },
                    "op": "ge",
                    "right": 0.5
                  },
                  {
                    "left": {
                      "metric": "giveback_atr"
                    },
                    "op": "ge",
                    "right": 2
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "underwater",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "age_h"
                    },
                    "op": "gt",
                    "right": 24
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "lt",
                    "right": 0
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "take-profit",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "ge",
                "right": 4.8
              }
            },
            {
              "to": "manage0",
              "label": "actual-fill",
              "when": {
                "left": {
                  "metric": "ready"
                },
                "op": "eq",
                "right": 1
              }
            }
          ]
        },
        "manage0": {
          "action": {
            "kind": "hold"
          },
          "next": [
            {
              "to": "exit",
              "label": "stop",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "le",
                "right": -2.5
              }
            },
            {
              "to": "exit",
              "label": "trailing",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "peak_move_atr"
                    },
                    "op": "ge",
                    "right": 0.5
                  },
                  {
                    "left": {
                      "metric": "giveback_atr"
                    },
                    "op": "ge",
                    "right": 2
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "underwater",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "age_h"
                    },
                    "op": "gt",
                    "right": 24
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "lt",
                    "right": 0
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "take-profit",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "ge",
                "right": 4.8
              }
            },
            {
              "to": "stage0",
              "label": "stage-trigger",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "filled"
                    },
                    "op": "eq",
                    "right": 1
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "ge",
                    "right": 0.25
                  }
                ]
              }
            }
          ]
        },
        "stage0": {
          "action": {
            "kind": "allocate",
            "weight": 1
          },
          "next": [
            {
              "to": "exit",
              "label": "stop",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "le",
                "right": -2.5
              }
            },
            {
              "to": "exit",
              "label": "trailing",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "peak_move_atr"
                    },
                    "op": "ge",
                    "right": 0.5
                  },
                  {
                    "left": {
                      "metric": "giveback_atr"
                    },
                    "op": "ge",
                    "right": 2
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "underwater",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "age_h"
                    },
                    "op": "gt",
                    "right": 24
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "lt",
                    "right": 0
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "take-profit",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "ge",
                "right": 4.8
              }
            },
            {
              "to": "manage1",
              "label": "stage-filled",
              "when": {
                "left": {
                  "metric": "ready"
                },
                "op": "eq",
                "right": 1
              }
            }
          ]
        },
        "manage1": {
          "action": {
            "kind": "hold"
          },
          "next": [
            {
              "to": "exit",
              "label": "stop",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "le",
                "right": -2.5
              }
            },
            {
              "to": "exit",
              "label": "trailing",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "peak_move_atr"
                    },
                    "op": "ge",
                    "right": 0.5
                  },
                  {
                    "left": {
                      "metric": "giveback_atr"
                    },
                    "op": "ge",
                    "right": 2
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "underwater",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "age_h"
                    },
                    "op": "gt",
                    "right": 24
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "lt",
                    "right": 0
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "take-profit",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "ge",
                "right": 4.8
              }
            },
            {
              "to": "stage1",
              "label": "stage-trigger",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "filled"
                    },
                    "op": "eq",
                    "right": 1
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "ge",
                    "right": 1
                  }
                ]
              }
            }
          ]
        },
        "stage1": {
          "action": {
            "kind": "trim",
            "keep": 0.75
          },
          "next": [
            {
              "to": "exit",
              "label": "stop",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "le",
                "right": -2.5
              }
            },
            {
              "to": "exit",
              "label": "trailing",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "peak_move_atr"
                    },
                    "op": "ge",
                    "right": 0.5
                  },
                  {
                    "left": {
                      "metric": "giveback_atr"
                    },
                    "op": "ge",
                    "right": 2
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "underwater",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "age_h"
                    },
                    "op": "gt",
                    "right": 24
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "lt",
                    "right": 0
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "take-profit",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "ge",
                "right": 4.8
              }
            },
            {
              "to": "run",
              "label": "stage-filled",
              "when": {
                "left": {
                  "metric": "ready"
                },
                "op": "eq",
                "right": 1
              }
            }
          ]
        },
        "run": {
          "action": {
            "kind": "hold"
          },
          "next": [
            {
              "to": "exit",
              "label": "stop",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "le",
                "right": -2.5
              }
            },
            {
              "to": "exit",
              "label": "trailing",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "peak_move_atr"
                    },
                    "op": "ge",
                    "right": 0.5
                  },
                  {
                    "left": {
                      "metric": "giveback_atr"
                    },
                    "op": "ge",
                    "right": 2
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "underwater",
              "when": {
                "all": [
                  {
                    "left": {
                      "metric": "age_h"
                    },
                    "op": "gt",
                    "right": 24
                  },
                  {
                    "left": {
                      "metric": "move_atr"
                    },
                    "op": "lt",
                    "right": 0
                  }
                ]
              }
            },
            {
              "to": "exit",
              "label": "take-profit",
              "when": {
                "left": {
                  "metric": "move_atr"
                },
                "op": "ge",
                "right": 4.8
              }
            }
          ]
        },
        "exit": {
          "action": {
            "kind": "flat"
          },
          "next": [
            {
              "to": "watch",
              "label": "actually-flat",
              "when": {
                "left": {
                  "metric": "filled"
                },
                "op": "eq",
                "right": 0
              }
            }
          ]
        }
      }
    }
  },
  "construction": {
    "generator": "reversal-v1",
    "blueprint": {
      "schema": 1,
      "asset": 1,
      "side": 1,
      "weight": 1,
      "gross_cap": 1,
      "position_atr": "atr14",
      "entry": {
        "mode": "all",
        "atoms": [
          {
            "feature": "vol14",
            "op": "gt",
            "value": 0.01
          },
          {
            "feature": "er48",
            "op": "gt",
            "value": 0.45
          },
          {
            "feature": "rsi14",
            "op": "le",
            "value": 65
          }
        ]
      },
      "exit_order": [
        "stop",
        "trailing",
        "underwater",
        "take_profit"
      ],
      "stop_atr": 2.5,
      "tp_atr": 4.8,
      "trail_arm_atr": 0.5,
      "trail_atr": 2,
      "max_loss_hours": 24,
      "modules": [
        {
          "kind": "scale",
          "at": 0.25,
          "weight": 1
        },
        {
          "kind": "trim",
          "at": 1,
          "keep": 0.75
        }
      ]
    },
    "topology": "c0a61b5ec8fecff42511f897997a8f8656ca61505303299bb2a6f84b7c8157cf"
  },
  "signature": "80c2547736b7b882e0f52781b73f09ffccccc685e3f3bbf5e56637a4babd8522"
});
export const ETH55_SPEC = ORIGINAL.spec;
// Preserve ORIGINAL's stored 15m envelope and identity; PAPER clocks separately.
export default ETH55_SPEC;
